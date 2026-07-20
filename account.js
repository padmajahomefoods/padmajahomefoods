// ============================================
// ACCOUNT.JS — Customer Authentication & Account Module
// Supabase Auth (Email + Password) for shop customers
// ============================================

// Helper to escape HTML and prevent XSS
const escapeHTML = (str) => String(str || '').replace(/[&<>'"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[m]);

const Account = {
    _client: null,
    _clientPromise: null,
    _currentUser: null,
    _currentProfile: null,
    _lastNotifiedUserId: null,

    async _initClient() {
        if (this._client) return this._client;
        if (this._clientPromise) return this._clientPromise;

        this._clientPromise = window.getSupabaseClient().then(client => {
            this._client = client;
            return client;
        }).catch(err => {
            console.error('Failed to initialize Supabase client in account:', err);
            throw err;
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
                console.log('[Account.initAuthListener] Auth state change:', event, 'session:', !!session);
                if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
                    this._currentUser = session?.user || null;
                    localStorage.setItem(CONFIG.CUSTOMER_SESSION_KEY, 'active');
                    this._updateAuthUI();
                    
                    // FIX: Dispatch userLoggedIn for email-verification logins
                    // This catches the case where user clicks email verification link
                    // and Supabase establishes a session via onAuthStateChange
                    const userId = session?.user?.id;
                    if (userId && this._lastNotifiedUserId !== userId) {
                        console.log('[Account.initAuthListener] New session detected for user:', userId, 'dispatching userLoggedIn');
                        this._lastNotifiedUserId = userId;
                        window.dispatchEvent(new CustomEvent('userLoggedIn'));
                    } else if (userId) {
                        console.log('[Account.initAuthListener] Already notified for user:', userId, 'skipping duplicate');
                    }
                } else if (event === 'SIGNED_OUT') {
                    this._currentUser = null;
                    this._currentProfile = null;
                    this._lastNotifiedUserId = null;
                    localStorage.removeItem(CONFIG.CUSTOMER_SESSION_KEY);
                    this._updateAuthUI();
                }
            });
        });
    },

    // --- CROSS-TAB SESSION DETECTION ---
    // Listen for storage changes from other tabs (e.g., email verification in new tab)
    _initCrossTabListener() {
        window.addEventListener('storage', async (e) => {
            if (e.key === CONFIG.CUSTOMER_SESSION_KEY) {
                // FIX: Use e.oldValue instead of this.isLoggedIn() because within a storage event, 
                // localStorage is already updated to e.newValue across all reads.
                if (e.newValue === 'active' && e.oldValue !== 'active') {
                    console.log('[Account._initCrossTabListener] Session detected in another tab, refreshing...');
                    await this.checkSession();
                    // Close auth modal if it's still open
                    const modal = document.getElementById('authModal');
                    if (modal && modal.classList.contains('active')) {
                        closeAuthModal();
                        showToast('Email verified! You are now logged in.', 'success');
                    }
                } else if (e.newValue === null && e.oldValue === 'active') {
                    console.log('[Account._initCrossTabListener] Session removed in another tab, logging out...');
                    await this.logOut();
                }
            } 
            // Fallback: Also listen for Supabase's native token key directly
            else if (e.key && e.key.startsWith('sb-') && e.key.endsWith('-auth-token')) {
                if (e.newValue && !this._currentUser) {
                    console.log('[Account._initCrossTabListener] Supabase token detected from another tab, checking session...');
                    await this.checkSession();
                }
            }
        });
    },

    // --- CHECK SESSION ON LOAD ---
    async checkSession() {
        const client = await this._getClient();
        if (!client) return false;

        // FIX: Use getUser() instead of getSession() for cross-tab sync.
        // getSession() reads from the Supabase client's in-memory cache, which
        // is stale when another tab wrote new auth tokens to localStorage.
        // getUser() forces the client to read the latest JWT from localStorage,
        // validate it against the Supabase API, and refresh its internal cache.
        const { data: userData, error: userError } = await client.auth.getUser();
        if (userError || !userData.user) {
            localStorage.removeItem(CONFIG.CUSTOMER_SESSION_KEY);
            this._currentUser = null;
            this._lastNotifiedUserId = null;
            this._updateAuthUI();
            return false;
        }

        this._currentUser = userData.user;
        localStorage.setItem(CONFIG.CUSTOMER_SESSION_KEY, 'active');
        this._updateAuthUI();
        
        // If we have a valid session on page load but haven't notified cart yet,
        // dispatch userLoggedIn. This handles page refreshes after email verification
        // and cross-tab login detection.
        const userId = userData.user?.id;
        if (userId && this._lastNotifiedUserId !== userId) {
            console.log('[Account.checkSession] Existing session found for user:', userId, 'dispatching userLoggedIn');
            this._lastNotifiedUserId = userId;
            window.dispatchEvent(new CustomEvent('userLoggedIn'));
        }
        
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
            await this._syncPhoneToProfile();

            // CRITICAL FIX: Ensure Supabase session is fully persisted before notifying cart
            // Force a small delay to let localStorage write complete
            await new Promise(resolve => setTimeout(resolve, 100));

            // Notify cart service to migrate guest cart
            // Use _lastNotifiedUserId to prevent duplicate notifications
            const userId = data.user?.id;
            if (userId && this._lastNotifiedUserId !== userId) {
                console.log('[Account.logIn] Dispatching userLoggedIn event for user:', userId);
                this._lastNotifiedUserId = userId;
                window.dispatchEvent(new CustomEvent('userLoggedIn'));
            } else {
                console.log('[Account.logIn] userLoggedIn already dispatched for user:', userId, 'skipping');
            }

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

        // If profile doesn't exist at all, create it with all data from user_metadata
        if (!profile) {
            const { data: created, error: createErr } = await client
                .from(CONFIG.TABLES.PROFILES)
                .insert({
                    id: user.id,
                    full_name: nameFromMeta || user.email?.split('@')[0] || '',
                    phone: phoneFromMeta
                })
                .select()
                .single();

            if (createErr) {
                console.warn('Profile create during sync failed:', createErr);
            } else {
                console.log('Profile created with phone from user_metadata');
                this._currentProfile = created;
            }
            return;
        }

        // Profile exists but missing phone/full_name - update it
        const updates = {};
        if (phoneFromMeta && !profile.phone) {
            updates.phone = phoneFromMeta;
        }
        if (nameFromMeta && !profile.full_name) {
            updates.full_name = nameFromMeta;
        }

        if (Object.keys(updates).length === 0) return;

        const { data: updated, error: updErr } = await client
            .from(CONFIG.TABLES.PROFILES)
            .update(updates)
            .eq('id', user.id)
            .select()
            .single();

        if (updErr) {
            console.warn('Profile sync warning:', updErr);
        } else {
            console.log('Profile synced with phone from user_metadata');
            this._currentProfile = updated;
        }
    },

    // --- LOG OUT ---
    async logOut() {
        // Notify cart service before clearing auth state
        window.dispatchEvent(new CustomEvent('userLoggedOut'));

        const client = await this._getClient();
        if (client) {
            await client.auth.signOut();
        }
        this._currentUser = null;
        this._currentProfile = null;
        this._lastNotifiedUserId = null;
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
        const { data: orders, error: ordersErr } = await client
            .from(CONFIG.TABLES.ORDERS)
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (ordersErr) {
            console.warn('Orders fetch error:', ordersErr);
            return [];
        }
        
        const orderIds = (orders || []).map(o => o.id);
        let orderItems = [];
        if (orderIds.length > 0) {
            const { data: items, error: itemsErr } = await client
                .from(CONFIG.TABLES.ORDER_ITEMS)
                .select('*')
                .in('order_id', orderIds);
                
            if (!itemsErr && items) {
                orderItems = items;
            }
        }
        
        return (orders || []).map(order => ({
            ...order,
            order_items: orderItems.filter(item => item.order_id === order.id)
        }));
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
        const mobileLogoutLi = document.getElementById('mobileLogoutLi');
        const mobileProfileBtn = document.getElementById('mobileProfileBtn');

        if (this.isLoggedIn() && this._currentUser) {
            const displayName = escapeHTML(this._currentUser.user_metadata?.full_name || 
                               this._currentUser.email?.split('@')[0] || 'Account');
            if (authBtn) {
                authBtn.innerHTML = '<i class="fas fa-user-circle"></i> <span>' + displayName + '</span>';
                authBtn.onclick = () => this.toggleAccountMenu();
            }
            if (mobileAuthLink) {
                mobileAuthLink.innerHTML = '<i class="fas fa-user-circle"></i> My Account';
                mobileAuthLink.onclick = (e) => { e.preventDefault(); openAccountPage(); closeMobileMenu(); };
            }
            if (mobileLogoutLi) {
                mobileLogoutLi.style.display = 'block';
            }
            if (mobileProfileBtn) {
                mobileProfileBtn.classList.add('logged-in');
                mobileProfileBtn.innerHTML = '<i class="fas fa-user"></i><span class="status-dot"></span>';
                mobileProfileBtn.onclick = (e) => { e.preventDefault(); openAccountPage(); };
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
            if (mobileLogoutLi) {
                mobileLogoutLi.style.display = 'none';
            }
            if (mobileProfileBtn) {
                mobileProfileBtn.classList.remove('logged-in');
                mobileProfileBtn.innerHTML = '<i class="far fa-user"></i><span class="status-dot"></span>';
                mobileProfileBtn.onclick = (e) => { e.preventDefault(); openAuthModal(); };
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
        this._initCrossTabListener();
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
            authToggleText.innerHTML = 'Don\'t have an account? <a href="#" onclick="switchAuthTab(\'signup\'); return false;">Sign Up</a>';
        }
    } else {
        signupTab?.classList.add('active');
        loginTab?.classList.remove('active');
        signupFields?.classList.add('active');
        loginFields?.classList.remove('active');
        if (authSubmitBtn) authSubmitBtn.textContent = 'Sign Up';
        if (authToggleText) {
            authToggleText.innerHTML = 'Already have an account? <a href="#" onclick="switchAuthTab(\'login\'); return false;">Log In</a>';
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
                    <input type="text" id="profileFullName" value="${escapeHTML(profile?.full_name || user?.user_metadata?.full_name || '')}" placeholder="Your full name" required>
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" value="${escapeHTML(user?.email || '')}" disabled class="disabled-input">
                    <small>Email cannot be changed</small>
                </div>
                <div class="form-group">
                    <label>Phone Number</label>
                    <input type="tel" id="profilePhone" value="${escapeHTML(phone)}" placeholder="Your phone number" maxlength="10">
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
                        <span class="address-label">${escapeHTML(addr.label)}</span>
                        ${addr.is_default ? '<span class="address-default-badge">Default</span>' : ''}
                    </div>
                    <div class="address-card-body">
                        <p class="address-name">${escapeHTML(addr.full_name)}</p>
                        <p class="address-text">${escapeHTML(addr.address_line1)}${addr.address_line2 ? ', ' + escapeHTML(addr.address_line2) : ''}</p>
                        <p class="address-city">${escapeHTML(addr.city)}, ${escapeHTML(addr.state)} - ${escapeHTML(addr.pincode)}</p>
                        <p class="address-phone"><i class="fas fa-phone"></i> ${escapeHTML(addr.phone)}</p>
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
            const total = Number(order.total_amount).toLocaleString('en-IN');
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
                        ${order.delivery_address ? `<p class="order-address"><i class="fas fa-map-marker-alt"></i> ${escapeHTML(order.delivery_address.city || '')}</p>` : ''}
                    </div>
                    <div class="order-card-items">
                        ${(order.order_items || []).map(item => `
                            <div class="order-item-row">
                                <span class="order-item-name">${escapeHTML(item.product_name)}</span>
                                <span class="order-item-detail">${escapeHTML(item.weight)} × ${item.quantity}</span>
                                <span class="order-item-price">₹${Number(item.total).toLocaleString('en-IN')}</span>
                            </div>
                        `).join('')}
                          <div style="margin-top: 15px; padding-top: 10px; border-top: 1px dashed var(--border); font-size: 0.9rem;">
                              ${(() => {
                                  let sub = order.subtotal || order.total_amount;
                                  let del = order.delivery_charge || 0;
                                  let disc = order.delivery_discount || 0;
                                  
                                  if (order.notes && typeof order.notes === 'string' && order.notes.includes('Subtotal:')) {
                                      const parts = order.notes.split('|').map(s => s.trim());
                                      parts.forEach(p => {
                                          if (p.startsWith('Subtotal:')) sub = parseFloat(p.replace('Subtotal:', '').trim()) || sub;
                                          if (p.startsWith('Delivery:')) del = parseFloat(p.replace('Delivery:', '').trim()) || del;
                                          if (p.startsWith('Discount:')) disc = parseFloat(p.replace('Discount:', '').trim()) || disc;
                                      });
                                  }
                                  
                                  return `
                                      <div style="display: flex; justify-content: space-between; margin-bottom: 5px; color: var(--text-gray);">
                                          <span>Subtotal</span>
                                          <span>₹${Number(sub).toLocaleString('en-IN')}</span>
                                      </div>
                                      <div style="display: flex; justify-content: space-between; margin-bottom: 5px; color: var(--text-gray);">
                                          <span>Delivery Charge</span>
                                          <span>${Number(del) === 0 ? 'Free' : '₹' + Number(del).toLocaleString('en-IN')}</span>
                                      </div>
                                      ${Number(disc) > 0 ? `
                                      <div style="display: flex; justify-content: space-between; margin-bottom: 5px; color: #48BB78; font-weight: 500;">
                                          <span>Delivery Discount</span>
                                          <span>-₹${Number(disc).toLocaleString('en-IN')}</span>
                                      </div>
                                      ` : ''}
                                      <div style="display: flex; justify-content: space-between; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); font-weight: 600; color: var(--text-dark);">
                                          <span>Grand Total</span>
                                          <span>₹${Number(order.total_amount).toLocaleString('en-IN')}</span>
                                      </div>
                                  `;
                              })()}
                          </div>
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

// Backup: check session when user returns to this tab after verifying in another tab
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && typeof Account !== 'undefined') {
        // FIX: The previous logic relied on Account.isLoggedIn() returning false, 
        // but Account.isLoggedIn() reads localStorage which is instantly shared across tabs.
        // Instead, we check if localStorage shows active, but our local memory state (_currentUser) is empty.
        if (Account.isLoggedIn() && !Account._currentUser) {
            console.log('[Account] Tab became visible, syncing active session from other tab...');
            await Account.checkSession();
            
            const modal = document.getElementById('authModal');
            if (modal && modal.classList.contains('active')) {
                closeAuthModal();
                showToast('Email verified! You are now logged in.', 'success');
            }
        } else if (!Account.isLoggedIn() && Account._currentUser) {
            console.log('[Account] Tab became visible, syncing logout...');
            await Account.logOut();
        }
    }
});