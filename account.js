// ============================================
// ACCOUNT.JS — Customer Authentication & Account Module
// Supabase Auth (Email + Password) for shop customers
// ============================================

const Account = {
    _client: null,
    _clientPromise: null,
    _currentUser: null,
    _currentProfile: null,

    async _initClient() {
        if (this._client) return this._client;
        if (this._clientPromise) return this._clientPromise;

        this._clientPromise = new Promise(async (resolve, reject) => {
            try {
                const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
                const createClient = module.createClient || module.default?.createClient;
                if (!createClient) {
                    const supabase = module.default || module;
                    this._client = supabase.createClient(
                        CONFIG.SUPABASE_URL,
                        CONFIG.SUPABASE_ANON_KEY
                    );
                } else {
                    this._client = createClient(
                        CONFIG.SUPABASE_URL,
                        CONFIG.SUPABASE_ANON_KEY
                    );
                }
                resolve(this._client);
            } catch (err) {
                console.error('Failed to initialize Supabase client:', err);
                reject(err);
            }
        });

        return this._clientPromise;
    },

    async _getClient() {
        if (!this._client) {
            await this._initClient();
        }
        return this._client;
    },

    // --- AUTH STATE LISTENER ---
    initAuthListener() {
        this._initClient().then(client => {
            client.auth.onAuthStateChange((event, session) => {
                if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                    this._currentUser = session?.user || null;
                    localStorage.setItem(CONFIG.CUSTOMER_SESSION_KEY, 'active');
                    this._updateAuthUI();
                } else if (event === 'SIGNED_OUT') {
                    this._currentUser = null;
                    this._currentProfile = null;
                    localStorage.removeItem(CONFIG.CUSTOMER_SESSION_KEY);
                    this._updateAuthUI();
                }
            });
        });
    },

    // --- CHECK SESSION ON LOAD ---
    async checkSession() {
        const client = await this._getClient();
        if (!client) return false;

        const { data, error } = await client.auth.getSession();
        if (error || !data.session) {
            localStorage.removeItem(CONFIG.CUSTOMER_SESSION_KEY);
            this._currentUser = null;
            this._updateAuthUI();
            return false;
        }

        this._currentUser = data.session.user;
        localStorage.setItem(CONFIG.CUSTOMER_SESSION_KEY, 'active');
        this._updateAuthUI();
        return true;
    },

    // --- SIGN UP ---
    async signUp(email, password, fullName, phone) {
        const client = await this._getClient();
        if (!client) {
            return { success: false, message: 'Authentication service not available.' };
        }

        const trimmedPhone = phone ? phone.trim() : '';
        const trimmedName = fullName.trim();
        const trimmedEmail = email.trim().toLowerCase();

        const { data, error } = await client.auth.signUp({
            email: trimmedEmail,
            password: password,
            options: {
                data: {
                    full_name: trimmedName,
                    phone: trimmedPhone
                }
            }
        });

        if (error) {
            if (error.message.includes('already registered')) {
                return { success: false, message: 'This email is already registered. Please log in.' };
            }
            if (error.message.includes('password')) {
                return { success: false, message: 'Password is too weak. Use at least 6 characters.' };
            }
            return { success: false, message: error.message };
        }

        // FIX: Always try to upsert profile immediately after signUp.
        // If email confirmation is required, the user won't have a session yet,
        // so we use the service role key approach OR we rely on a database trigger.
        // Since we can't use service role from client, we try with current auth context.
        // If it fails (RLS), the data is still in user_metadata as fallback.
        if (data.user) {
            const profileData = {
                id: data.user.id,
                full_name: trimmedName,
                phone: trimmedPhone
            };

            // Attempt 1: Direct upsert (works if user is auto-confirmed or RLS allows)
            const { error: profileErr } = await client
                .from(CONFIG.TABLES.PROFILES)
                .upsert(profileData, { onConflict: 'id' });

            if (profileErr) {
                console.warn('Profile upsert warning (may need email confirm first):', profileErr);
                // The profile might be created by a database trigger instead.
                // We'll sync phone on next login via getProfile's user_metadata fallback.
            }
        }

        if (data.user && data.session) {
            this._currentUser = data.user;
            localStorage.setItem(CONFIG.CUSTOMER_SESSION_KEY, 'active');
            this._updateAuthUI();
            return { success: true, message: 'Account created successfully!' };
        }

        return { success: true, message: 'Please check your email to confirm your account.' };
    },

    // --- LOG IN ---
    async logIn(email, password) {
        const client = await this._getClient();
        if (!client) {
            return { success: false, message: 'Authentication service not available.' };
        }

        const { data, error } = await client.auth.signInWithPassword({
            email: email.trim().toLowerCase(),
            password: password
        });

        if (error) {
            if (error.message.includes('Invalid login credentials')) {
                return { success: false, message: 'Invalid email or password.' };
            }
            if (error.message.includes('Email not confirmed')) {
                return { success: false, message: 'Please confirm your email before logging in.' };
            }
            return { success: false, message: error.message };
        }

        if (data.session) {
            this._currentUser = data.user;
            localStorage.setItem(CONFIG.CUSTOMER_SESSION_KEY, 'active');

            // FIX: After login, sync user_metadata (phone) to profiles table
            // in case the profile was created by trigger without phone
            await this._syncPhoneToProfile();

            this._updateAuthUI();
            return { success: true, message: 'Logged in successfully!' };
        }

        return { success: false, message: 'Login failed. Please try again.' };
    },

    // FIX: New helper to sync phone from user_metadata to profiles table
    async _syncPhoneToProfile() {
        const user = this._currentUser;
        if (!user) return;

        const phoneFromMeta = user.user_metadata?.phone || '';
        const nameFromMeta = user.user_metadata?.full_name || '';
        if (!phoneFromMeta && !nameFromMeta) return;

        const client = await this._getClient();
        if (!client) return;

        // Check current profile
        const { data: profile, error: fetchErr } = await client
            .from(CONFIG.TABLES.PROFILES)
            .select('id, full_name, phone')
            .eq('id', user.id)
            .single();

        if (fetchErr && fetchErr.code !== 'PGRST116') {
            console.warn('Profile fetch during sync:', fetchErr);
            return;
        }

        const updates = {};
        if (phoneFromMeta && (!profile || !profile.phone)) {
            updates.phone = phoneFromMeta;
        }
        if (nameFromMeta && (!profile || !profile.full_name)) {
            updates.full_name = nameFromMeta;
        }

        if (Object.keys(updates).length === 0) return;

        const { error: updErr } = await client
            .from(CONFIG.TABLES.PROFILES)
            .upsert({
                id: user.id,
                ...updates
            }, { onConflict: 'id' });

        if (updErr) {
            console.warn('Profile sync warning:', updErr);
        } else {
            // Clear cached profile so next getProfile() fetches fresh data
            this._currentProfile = null;
        }
    },

    // --- LOG OUT ---
    async logOut() {
        const client = await this._getClient();
        if (client) {
            await client.auth.signOut();
        }
        this._currentUser = null;
        this._currentProfile = null;
        localStorage.removeItem(CONFIG.CUSTOMER_SESSION_KEY);
        this._updateAuthUI();
        return { success: true };
    },

    // --- GET CURRENT USER ---
    async getCurrentUser() {
        if (this._currentUser) return this._currentUser;
        const client = await this._getClient();
        if (!client) return null;
        const { data, error } = await client.auth.getUser();
        if (error) return null;
        this._currentUser = data.user;
        return data.user;
    },

    // --- IS LOGGED IN ---
    isLoggedIn() {
        return localStorage.getItem(CONFIG.CUSTOMER_SESSION_KEY) === 'active';
    },

    // --- PROFILE ---
    async getProfile() {
        const user = await this.getCurrentUser();
        if (!user) return null;

        // FIX: Don't return stale cached profile if phone might be missing
        // Always re-fetch to ensure phone from user_metadata is synced
        this._currentProfile = null;

        if (this._currentProfile) return this._currentProfile;

        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.PROFILES)
            .select('*')
            .eq('id', user.id)
            .single();

        if (error) {
            console.warn('Profile fetch error:', error);
            // If profile row doesn't exist, auto-create from user_metadata so phone persists
            if (error.code === 'PGRST116' || error.message?.includes('0 rows') || error.message?.includes('Results contain 0 rows')) {
                const fallbackPhone = user.user_metadata?.phone || '';
                const fallbackName = user.user_metadata?.full_name || '';
                const { data: created, error: createErr } = await client
                    .from(CONFIG.TABLES.PROFILES)
                    .insert({
                        id: user.id,
                        full_name: fallbackName,
                        phone: fallbackPhone
                    })
                    .select()
                    .single();
                if (!createErr && created) {
                    this._currentProfile = created;
                    return created;
                }
                console.warn('Auto-create profile failed:', createErr);
            }
            return null;
        }

        // FIX: If profile exists but phone is empty, sync from user_metadata
        const phoneFromMeta = user.user_metadata?.phone || '';
        const nameFromMeta = user.user_metadata?.full_name || '';
        if ((!data.phone && phoneFromMeta) || (!data.full_name && nameFromMeta)) {
            const updates = {};
            if (!data.phone && phoneFromMeta) updates.phone = phoneFromMeta;
            if (!data.full_name && nameFromMeta) updates.full_name = nameFromMeta;

            const { data: updated, error: updErr } = await client
                .from(CONFIG.TABLES.PROFILES)
                .update(updates)
                .eq('id', user.id)
                .select()
                .single();

            if (!updErr && updated) {
                this._currentProfile = updated;
                return updated;
            }
        }

        this._currentProfile = data;
        return data;
    },

    async updateProfile(updates) {
        const user = await this.getCurrentUser();
        if (!user) return { success: false, message: 'Not logged in' };

        const client = await this._getClient();

        // Sync phone and name to user_metadata as well (reliable fallback storage)
        const { error: metaErr } = await client.auth.updateUser({
            data: {
                full_name: updates.full_name,
                phone: updates.phone
            }
        });
        if (metaErr) {
            console.warn('Failed to sync profile to user_metadata:', metaErr);
        }

        const { data, error } = await client
            .from(CONFIG.TABLES.PROFILES)
            .update({
                full_name: updates.full_name,
                phone: updates.phone,
                updated_at: new Date().toISOString()
            })
            .eq('id', user.id)
            .select()
            .single();

        if (error) return { success: false, message: error.message };
        this._currentProfile = data;
        return { success: true, data };
    },

    // --- ADDRESSES ---
    async getAddresses() {
        const user = await this.getCurrentUser();
        if (!user) return [];

        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.ADDRESSES)
            .select('*')
            .eq('user_id', user.id)
            .order('is_default', { ascending: false })
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('Addresses fetch error:', error);
            return [];
        }
        return data || [];
    },

    async addAddress(address) {
        const user = await this.getCurrentUser();
        if (!user) return { success: false, message: 'Not logged in' };

        const client = await this._getClient();

        if (address.is_default) {
            await client
                .from(CONFIG.TABLES.ADDRESSES)
                .update({ is_default: false })
                .eq('user_id', user.id);
        }

        const { data, error } = await client
            .from(CONFIG.TABLES.ADDRESSES)
            .insert({
                user_id: user.id,
                label: address.label || 'Home',
                full_name: address.full_name,
                phone: address.phone,
                address_line1: address.address_line1,
                address_line2: address.address_line2 || '',
                city: address.city,
                state: address.state || 'Andhra Pradesh',
                pincode: address.pincode,
                is_default: address.is_default || false
            })
            .select()
            .single();

        if (error) return { success: false, message: error.message };
        return { success: true, data };
    },

    async updateAddress(id, address) {
        const user = await this.getCurrentUser();
        if (!user) return { success: false, message: 'Not logged in' };

        const client = await this._getClient();

        if (address.is_default) {
            await client
                .from(CONFIG.TABLES.ADDRESSES)
                .update({ is_default: false })
                .eq('user_id', user.id);
        }

        const { data, error } = await client
            .from(CONFIG.TABLES.ADDRESSES)
            .update({
                label: address.label,
                full_name: address.full_name,
                phone: address.phone,
                address_line1: address.address_line1,
                address_line2: address.address_line2 || '',
                city: address.city,
                state: address.state || 'Andhra Pradesh',
                pincode: address.pincode,
                is_default: address.is_default || false,
                updated_at: new Date().toISOString()
            })
            .eq('id', id)
            .eq('user_id', user.id)
            .select()
            .single();

        if (error) return { success: false, message: error.message };
        return { success: true, data };
    },

    async deleteAddress(id) {
        const user = await this.getCurrentUser();
        if (!user) return { success: false, message: 'Not logged in' };

        const client = await this._getClient();
        const { error } = await client
            .from(CONFIG.TABLES.ADDRESSES)
            .delete()
            .eq('id', id)
            .eq('user_id', user.id);

        if (error) return { success: false, message: error.message };
        return { success: true };
    },

    // --- ORDERS ---
    async getOrders() {
        const user = await this.getCurrentUser();
        if (!user) return [];

        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.ORDERS)
            .select(`*, ${CONFIG.TABLES.ORDER_ITEMS}(*)`)
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.warn('Orders fetch error:', error);
            return [];
        }
        return data || [];
    },

    async placeOrder(orderData) {
        const user = await this.getCurrentUser();
        if (!user) return { success: false, message: 'Not logged in' };

        const client = await this._getClient();

        const { data: orderNumData, error: orderNumErr } = await client.rpc('generate_order_number');
        const orderNumber = orderNumErr || !orderNumData ? 'PHF' + Date.now() : orderNumData;

        const { data: order, error: orderError } = await client
            .from(CONFIG.TABLES.ORDERS)
            .insert({
                user_id: user.id,
                order_number: orderNumber,
                total_amount: orderData.total_amount,
                delivery_address: orderData.delivery_address,
                whatsapp_number: orderData.whatsapp_number || '',
                notes: orderData.notes || ''
            })
            .select()
            .single();

        if (orderError) return { success: false, message: orderError.message };

        const orderItems = orderData.items.map(item => ({
            order_id: order.id,
            product_id: item.product_id || '',
            product_name: item.product_name,
            weight: item.weight,
            price: item.price,
            quantity: item.quantity,
            total: item.price * item.quantity
        }));

        const { error: itemsError } = await client
            .from(CONFIG.TABLES.ORDER_ITEMS)
            .insert(orderItems);

        if (itemsError) {
            await client.from(CONFIG.TABLES.ORDERS).delete().eq('id', order.id);
            return { success: false, message: itemsError.message };
        }

        return { success: true, order };
    },

    // --- UI HELPERS ---
    _updateAuthUI() {
        const authBtn = document.getElementById('authBtn');
        const accountMenu = document.getElementById('accountMenu');
        const mobileAuthLink = document.getElementById('mobileAuthLink');

        if (this.isLoggedIn() && this._currentUser) {
            const displayName = this._currentUser.user_metadata?.full_name || 
                               this._currentUser.email?.split('@')[0] || 'Account';
            if (authBtn) {
                authBtn.innerHTML = '<i class="fas fa-user-circle"></i> <span>' + displayName + '</span>';
                authBtn.onclick = () => this.toggleAccountMenu();
            }
            if (mobileAuthLink) {
                mobileAuthLink.innerHTML = '<i class="fas fa-user-circle"></i> My Account';
                mobileAuthLink.onclick = (e) => { e.preventDefault(); openAccountPage(); closeMobileMenu(); };
            }
        } else {
            if (authBtn) {
                authBtn.innerHTML = '<i class="fas fa-user"></i> <span>Login</span>';
                authBtn.onclick = () => openAuthModal();
            }
            if (mobileAuthLink) {
                mobileAuthLink.innerHTML = '<i class="fas fa-user"></i> Login / Sign Up';
                mobileAuthLink.onclick = (e) => { e.preventDefault(); openAuthModal(); closeMobileMenu(); };
            }
        }
    },

    toggleAccountMenu() {
        const menu = document.getElementById('accountMenu');
        if (menu) {
            menu.classList.toggle('active');
        }
    },

    // --- INIT ---
    async init() {
        this.initAuthListener();
        await this.checkSession();
    }
};

// ============================================
// AUTH MODAL UI FUNCTIONS
// ============================================

function openAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        switchAuthTab('login');
    }
}

function closeAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
        const form = document.getElementById('authForm');
        if (form) form.reset();
        hideAuthError();
    }
}

function switchAuthTab(tab) {
    const loginTab = document.getElementById('loginTab');
    const signupTab = document.getElementById('signupTab');
    const loginFields = document.getElementById('loginFields');
    const signupFields = document.getElementById('signupFields');
    const authSubmitBtn = document.getElementById('authSubmitBtn');
    const authToggleText = document.getElementById('authToggleText');

    if (tab === 'login') {
        loginTab?.classList.add('active');
        signupTab?.classList.remove('active');
        loginFields?.classList.add('active');
        signupFields?.classList.remove('active');
        if (authSubmitBtn) authSubmitBtn.textContent = 'Log In';
        if (authToggleText) {
            authToggleText.innerHTML = "Don't have an account? <a href="#" onclick="switchAuthTab('signup'); return false;">Sign Up</a>";
        }
    } else {
        signupTab?.classList.add('active');
        loginTab?.classList.remove('active');
        signupFields?.classList.add('active');
        loginFields?.classList.remove('active');
        if (authSubmitBtn) authSubmitBtn.textContent = 'Sign Up';
        if (authToggleText) {
            authToggleText.innerHTML = "Already have an account? <a href="#" onclick="switchAuthTab('login'); return false;">Log In</a>";
        }
    }
    hideAuthError();
}

function showAuthError(message) {
    const errorEl = document.getElementById('authError');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }
}

function hideAuthError() {
    const errorEl = document.getElementById('authError');
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
    }
}

function showAuthSuccess(message) {
    const successEl = document.getElementById('authSuccess');
    if (successEl) {
        successEl.textContent = message;
        successEl.style.display = 'block';
        setTimeout(() => { successEl.style.display = 'none'; }, 3000);
    }
}

async function handleAuthSubmit(e) {
    e.preventDefault();
    hideAuthError();

    const loginTab = document.getElementById('loginTab');
    const isLogin = loginTab?.classList.contains('active');

    const email = isLogin 
        ? document.getElementById('authEmail').value.trim() 
        : document.getElementById('authEmailSignup').value.trim();
    const password = isLogin 
        ? document.getElementById('authPassword').value 
        : document.getElementById('authPasswordSignup').value;

    if (!email || !password) {
        showAuthError('Please enter both email and password.');
        return;
    }

    const submitBtn = document.getElementById('authSubmitBtn');
    const originalText = submitBtn?.textContent;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = isLogin ? 'Logging in...' : 'Creating account...';
    }

    let result;
    if (isLogin) {
        result = await Account.logIn(email, password);
    } else {
        const fullName = document.getElementById('authFullName').value.trim();
        const phone = document.getElementById('authPhone').value.trim();
        const confirmPassword = document.getElementById('authConfirmPassword').value;

        if (!fullName) {
            showAuthError('Please enter your full name.');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
            return;
        }
        if (password.length < 6) {
            showAuthError('Password must be at least 6 characters.');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
            return;
        }
        if (password !== confirmPassword) {
            showAuthError('Passwords do not match.');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalText; }
            return;
        }

        result = await Account.signUp(email, password, fullName, phone);
    }

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }

    if (result.success) {
        showAuthSuccess(result.message);
        if (isLogin || result.message.includes('successfully')) {
            setTimeout(() => {
                closeAuthModal();
            }, 1000);
        }
    } else {
        showAuthError(result.message);
    }
}

async function handleLogout() {
    await Account.logOut();
    showToast('Logged out successfully', 'info');
    Account.toggleAccountMenu();
    if (document.getElementById('accountPage')?.classList.contains('active')) {
        closeAccountPage();
    }
}

// ============================================
// ACCOUNT PAGE UI
// ============================================

function openAccountPage() {
    const page = document.getElementById('accountPage');
    if (page) {
        page.classList.add('active');
        document.body.style.overflow = 'hidden';
        loadAccountContent('profile');
    }
    const menu = document.getElementById('accountMenu');
    if (menu) menu.classList.remove('active');
}

function closeAccountPage() {
    const page = document.getElementById('accountPage');
    if (page) {
        page.classList.remove('active');
        document.body.style.overflow = '';
    }
}

function switchAccountTab(tab) {
    document.querySelectorAll('.account-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.account-tab-content').forEach(content => content.classList.remove('active'));

    const activeBtn = document.querySelector('.account-tab-btn[data-tab="' + tab + '"]');
    const activeContent = document.getElementById('tab-' + tab);

    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');

    loadAccountContent(tab);
}

async function loadAccountContent(tab) {
    if (tab === 'profile') {
        await loadProfileTab();
    } else if (tab === 'addresses') {
        await loadAddressesTab();
    } else if (tab === 'orders') {
        await loadOrdersTab();
    }
}

async function loadProfileTab() {
    const container = document.getElementById('tab-profile');
    if (!container) return;

    const user = await Account.getCurrentUser();
    const profile = await Account.getProfile();

    // FALLBACK: if profiles table is missing phone, read from user_metadata (always reliable)
    const phone = profile?.phone || user?.user_metadata?.phone || '';

    container.innerHTML = `
        <div class="account-section">
            <h4><i class="fas fa-user"></i> Profile Information</h4>
            <form id="profileForm" onsubmit="handleProfileUpdate(event)">
                <div class="form-group">
                    <label>Full Name</label>
                    <input type="text" id="profileFullName" value="${profile?.full_name || user?.user_metadata?.full_name || ''}" placeholder="Your full name" required>
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" value="${user?.email || ''}" disabled class="disabled-input">
                    <small>Email cannot be changed</small>
                </div>
                <div class="form-group">
                    <label>Phone Number</label>
                    <input type="tel" id="profilePhone" value="${phone}" placeholder="Your phone number" maxlength="10">
                </div>
                <button type="submit" class="btn-primary" style="width: auto; padding: 12px 28px;">
                    <i class="fas fa-save"></i> Save Changes
                </button>
            </form>
        </div>
    `;
}

async function handleProfileUpdate(e) {
    e.preventDefault();
    const fullName = document.getElementById('profileFullName').value.trim();
    const phone = document.getElementById('profilePhone').value.trim();

    const result = await Account.updateProfile({ full_name: fullName, phone: phone });
    if (result.success) {
        showToast('Profile updated successfully', 'success');
        Account._updateAuthUI();
    } else {
        showToast(result.message, 'error');
    }
}

async function loadAddressesTab() {
    const container = document.getElementById('tab-addresses');
    if (!container) return;

    const addresses = await Account.getAddresses();

    let html = '<div class="account-section">';
    html += '<div class="account-section-header"><h4><i class="fas fa-map-marker-alt"></i> My Addresses</h4>';
    html += '<button class="btn-primary" style="padding: 10px 20px; font-size: 0.85rem;" onclick="openAddressForm()"><i class="fas fa-plus"></i> Add New</button></div>';

    if (addresses.length === 0) {
        html += '<div class="account-empty"><i class="fas fa-map-marker-alt"></i><p>No addresses saved yet.</p><button class="btn-primary" onclick="openAddressForm()">Add Address</button></div>';
    } else {
        html += '<div class="addresses-list">';
        addresses.forEach(addr => {
            html += `
                <div class="address-card">
                    <div class="address-card-header">
                        <span class="address-label">${addr.label}</span>
                        ${addr.is_default ? '<span class="address-default-badge">Default</span>' : ''}
                    </div>
                    <div class="address-card-body">
                        <p class="address-name">${addr.full_name}</p>
                        <p class="address-text">${addr.address_line1}${addr.address_line2 ? ', ' + addr.address_line2 : ''}</p>
                        <p class="address-city">${addr.city}, ${addr.state} - ${addr.pincode}</p>
                        <p class="address-phone"><i class="fas fa-phone"></i> ${addr.phone}</p>
                    </div>
                    <div class="address-card-actions">
                        <button onclick="editAddress('${addr.id}')" class="btn-edit"><i class="fas fa-edit"></i> Edit</button>
                        <button onclick="deleteAddress('${addr.id}')" class="btn-delete"><i class="fas fa-trash"></i> Delete</button>
                    </div>
                </div>
            `;
        });
        html += '</div>';
    }
    html += '</div>';

    html += `
        <div id="addressFormModal" class="address-form-modal" onclick="if(event.target===this)closeAddressForm()">
            <div class="address-form-content">
                <h4 id="addressFormTitle">Add New Address</h4>
                <form id="addressForm" onsubmit="handleAddressSubmit(event)">
                    <input type="hidden" id="addressId">
                    <div class="form-row">
                        <div class="form-group">
                            <label>Label</label>
                            <select id="addressLabel">
                                <option value="Home">Home</option>
                                <option value="Work">Work</option>
                                <option value="Other">Other</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Full Name *</label>
                            <input type="text" id="addressFullName" required>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Phone Number *</label>
                        <input type="tel" id="addressPhone" required maxlength="10">
                    </div>
                    <div class="form-group">
                        <label>Address Line 1 *</label>
                        <input type="text" id="addressLine1" required placeholder="House no, Street, Area">
                    </div>
                    <div class="form-group">
                        <label>Address Line 2</label>
                        <input type="text" id="addressLine2" placeholder="Landmark, Apartment (optional)">
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>City *</label>
                            <input type="text" id="addressCity" required>
                        </div>
                        <div class="form-group">
                            <label>State</label>
                            <input type="text" id="addressState" value="Andhra Pradesh">
                        </div>
                        <div class="form-group">
                            <label>Pincode *</label>
                            <input type="text" id="addressPincode" required maxlength="6">
                        </div>
                    </div>
                    <div class="form-group checkbox-group">
                        <label><input type="checkbox" id="addressIsDefault"> Set as default address</label>
                    </div>
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" onclick="closeAddressForm()">Cancel</button>
                        <button type="submit" class="btn-primary">Save Address</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    container.innerHTML = html;
}

function openAddressForm(addressId) {
    const modal = document.getElementById('addressFormModal');
    const title = document.getElementById('addressFormTitle');
    const form = document.getElementById('addressForm');

    if (modal) modal.classList.add('active');

    if (addressId) {
        if (title) title.textContent = 'Edit Address';
        Account.getAddresses().then(addresses => {
            const addr = addresses.find(a => a.id === addressId);
            if (addr) {
                document.getElementById('addressId').value = addr.id;
                document.getElementById('addressLabel').value = addr.label;
                document.getElementById('addressFullName').value = addr.full_name;
                document.getElementById('addressPhone').value = addr.phone;
                document.getElementById('addressLine1').value = addr.address_line1;
                document.getElementById('addressLine2').value = addr.address_line2 || '';
                document.getElementById('addressCity').value = addr.city;
                document.getElementById('addressState').value = addr.state;
                document.getElementById('addressPincode').value = addr.pincode;
                document.getElementById('addressIsDefault').checked = addr.is_default;
            }
        });
    } else {
        if (title) title.textContent = 'Add New Address';
        if (form) form.reset();
        document.getElementById('addressId').value = '';
        document.getElementById('addressState').value = 'Andhra Pradesh';
    }
}

function closeAddressForm() {
    const modal = document.getElementById('addressFormModal');
    if (modal) modal.classList.remove('active');
}

function editAddress(id) {
    openAddressForm(id);
}

async function deleteAddress(id) {
    if (!confirm('Are you sure you want to delete this address?')) return;
    const result = await Account.deleteAddress(id);
    if (result.success) {
        showToast('Address deleted', 'success');
        loadAddressesTab();
    } else {
        showToast(result.message, 'error');
    }
}

async function handleAddressSubmit(e) {
    e.preventDefault();

    const id = document.getElementById('addressId').value;
    const address = {
        label: document.getElementById('addressLabel').value,
        full_name: document.getElementById('addressFullName').value.trim(),
        phone: document.getElementById('addressPhone').value.trim(),
        address_line1: document.getElementById('addressLine1').value.trim(),
        address_line2: document.getElementById('addressLine2').value.trim(),
        city: document.getElementById('addressCity').value.trim(),
        state: document.getElementById('addressState').value.trim(),
        pincode: document.getElementById('addressPincode').value.trim(),
        is_default: document.getElementById('addressIsDefault').checked
    };

    let result;
    if (id) {
        result = await Account.updateAddress(id, address);
    } else {
        result = await Account.addAddress(address);
    }

    if (result.success) {
        showToast(id ? 'Address updated' : 'Address added', 'success');
        closeAddressForm();
        loadAddressesTab();
    } else {
        showToast(result.message, 'error');
    }
}

async function loadOrdersTab() {
    const container = document.getElementById('tab-orders');
    if (!container) return;

    const orders = await Account.getOrders();

    let html = '<div class="account-section">';
    html += '<h4><i class="fas fa-box"></i> My Orders</h4>';

    if (orders.length === 0) {
        html += '<div class="account-empty"><i class="fas fa-shopping-bag"></i><p>No orders yet.</p><a href="index.html" class="btn-primary" style="display:inline-flex;">Start Shopping</a></div>';
    } else {
        html += '<div class="orders-list">';
        orders.forEach(order => {
            const statusClass = 'status-' + order.status;
            const statusText = order.status.charAt(0).toUpperCase() + order.status.slice(1);
            const date = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
            const total = (order.total_amount / 100).toLocaleString('en-IN');
            const itemCount = order.order_items?.length || 0;

            html += `
                <div class="order-card">
                    <div class="order-card-header">
                        <div>
                            <span class="order-number">${order.order_number}</span>
                            <span class="order-date">${date}</span>
                        </div>
                        <span class="order-status ${statusClass}">${statusText}</span>
                    </div>
                    <div class="order-card-body">
                        <p class="order-items-count">${itemCount} item${itemCount !== 1 ? 's' : ''}</p>
                        <p class="order-total">Total: <strong>₹${total}</strong></p>
                        ${order.delivery_address ? `<p class="order-address"><i class="fas fa-map-marker-alt"></i> ${order.delivery_address.city || ''}</p>` : ''}
                    </div>
                    <div class="order-card-items">
                        ${(order.order_items || []).map(item => `
                            <div class="order-item-row">
                                <span class="order-item-name">${item.product_name}</span>
                                <span class="order-item-detail">${item.weight} × ${item.quantity}</span>
                                <span class="order-item-price">₹${(item.total / 100).toLocaleString('en-IN')}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        });
        html += '</div>';
    }
    html += '</div>';

    container.innerHTML = html;
}

// Close account menu when clicking outside
document.addEventListener('click', function(e) {
    const menu = document.getElementById('accountMenu');
    const authBtn = document.getElementById('authBtn');
    if (menu && authBtn && !menu.contains(e.target) && !authBtn.contains(e.target)) {
        menu.classList.remove('active');
    }
});

// Initialize account module on load
document.addEventListener('DOMContentLoaded', function() {
    Account.init();
});
