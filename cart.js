// ============================================
// CART.JS — Hybrid Cart Service
// Guest: localStorage | Logged-in: Supabase
// ============================================

const CartService = {
    // --- State ---
    _client: null,
    _localCart: [],
    _supabaseCart: [],
    _isSyncing: false,
    _syncQueue: [],
    _supabaseCartLoaded: false,

    // --- Constants ---
    STORAGE_KEY: CONFIG.CART_STORAGE_KEY || 'padmaja_cart',
    MAX_QTY: 10,

    // --- Initialization ---
    async init() {
        console.log('[CartService.init] Starting initialization...');
        
        // Load app settings from database before initializing cart UI
        if (typeof SettingsService !== 'undefined' && SettingsService.loadSettings) {
            await SettingsService.loadSettings();
        }
        
        this._loadLocalCart();
        console.log('[CartService.init] Local cart loaded:', this._localCart.length, 'items');

        // If user is logged in, load from Supabase and migrate if needed
        if (Account.isLoggedIn()) {
            console.log('[CartService.init] User already logged in, initializing Supabase cart...');
            await this._initSupabaseCart();
        } else {
            console.log('[CartService.init] User is guest, using local cart only');
        }

        this._notifyUpdate();
        console.log('[CartService.init] Initialization complete. Total items:', this.getTotalItems());
    },

    // --- Client ---
    async _getClient() {
        if (this._client) {
            // Verify the client still has a valid session before returning
            const { data: { session } } = await this._client.auth.getSession();
            if (session) {
                return this._client;
            }
            console.log('[CartService._getClient] Cached client has no session, recreating...');
            this._client = null;
        }
        
        const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
        const supabase = module.default || module;
        this._client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
        
        // Log session status for debugging
        const { data: { session } } = await this._client.auth.getSession();
        console.log('[CartService._getClient] New client created. Session present:', !!session);
        
        return this._client;
    },

    // --- Mode Detection ---
    _isLoggedIn() {
        return Account.isLoggedIn && Account.isLoggedIn();
    },

    // ============================================
    // LOCAL STORAGE (Guest Mode)
    // ============================================
    _loadLocalCart() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                this._localCart = data.version === 2 ? (data.items || []) : [];
                console.log('[CartService._loadLocalCart] Loaded', this._localCart.length, 'items from localStorage');
            } else {
                this._localCart = [];
                console.log('[CartService._loadLocalCart] No local cart found');
            }
        } catch (e) {
            console.warn('[CartService._loadLocalCart] Failed to load local cart:', e);
            this._localCart = [];
        }
    },

    _saveLocalCart() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                version: 2,
                items: this._localCart
            }));
            console.log('[CartService._saveLocalCart] Saved', this._localCart.length, 'items to localStorage');
        } catch (e) {
            console.warn('[CartService._saveLocalCart] Failed to save local cart:', e);
        }
    },

    _clearLocalCart() {
        console.log('[CartService._clearLocalCart] Clearing local cart. Items before clear:', this._localCart.length);
        this._localCart = [];
        localStorage.removeItem(this.STORAGE_KEY);
        console.log('[CartService._clearLocalCart] Local cart cleared');
    },

    // ============================================
    // SUPABASE (Logged-in Mode)
    // ============================================
    async _initSupabaseCart() {
        console.log('[CartService._initSupabaseCart] Starting Supabase cart init...');
        this._supabaseCartLoaded = false;
        
        // DEFENSIVE: Always re-read localStorage to ensure we have latest data
        this._loadLocalCart();
        const hasLocalItems = this._localCart.length > 0;
        console.log('[CartService._initSupabaseCart] Has local items after reload:', hasLocalItems, 'items:', this._localCart);

        await this._loadSupabaseCart();
        console.log('[CartService._initSupabaseCart] Supabase cart loaded:', this._supabaseCart.length, 'items');

        if (hasLocalItems) {
            console.log('[CartService._initSupabaseCart] Local items detected, starting migration...');
            const migrationSuccess = await this._migrateLocalToSupabase();
            
            if (migrationSuccess) {
                console.log('[CartService._initSupabaseCart] Migration succeeded, clearing local cart');
                this._clearLocalCart();
                console.log('[CartService._initSupabaseCart] Reloading Supabase cart after migration...');
                await this._loadSupabaseCart();
                console.log('[CartService._initSupabaseCart] Post-migration Supabase cart:', this._supabaseCart.length, 'items');
            } else {
                console.error('[CartService._initSupabaseCart] Migration FAILED. Keeping local cart as fallback.');
                // CRITICAL FIX: If migration fails, don't treat as empty
                // Keep local cart in memory so user doesn't lose items
                if (this._localCart.length === 0) {
                    this._supabaseCartLoaded = true;
                }
                return;
            }
        } else {
            console.log('[CartService._initSupabaseCart] No local items to migrate');
        }
        
        this._supabaseCartLoaded = true;
        console.log('[CartService._initSupabaseCart] Final state - Supabase:', this._supabaseCart.length, 'Local:', this._localCart.length);
    },

    async _loadSupabaseCart() {
        console.log('[CartService._loadSupabaseCart] Loading from Supabase...');
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            
            console.log('[CartService._loadSupabaseCart] Current user:', user ? user.id : 'null');
            
            if (!user) {
                console.warn('[CartService._loadSupabaseCart] No user, clearing Supabase cart');
                this._supabaseCart = [];
                return;
            }

            const { data, error } = await client
                .from('cart_items')
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) {
                console.warn('[CartService._loadSupabaseCart] Failed to load Supabase cart:', error);
                this._supabaseCart = [];
                return;
            }

            this._supabaseCart = (data || []).map(row => this._rowToItem(row));
            this._supabaseCartLoaded = true;
            console.log('[CartService._loadSupabaseCart] Loaded', this._supabaseCart.length, 'items from Supabase');
        } catch (e) {
            console.warn('[CartService._loadSupabaseCart] Error loading Supabase cart:', e);
            this._supabaseCart = [];
        }
    },

    async _migrateLocalToSupabase() {
        console.log('[CartService._migrateLocalToSupabase] Starting migration...');
        console.log('[CartService._migrateLocalToSupabase] Local items to migrate:', this._localCart);
        
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            
            console.log('[CartService._migrateLocalToSupabase] User:', user ? user.id : 'null');
            console.log('[CartService._migrateLocalToSupabase] Local cart length:', this._localCart.length);
            
            if (!user) {
                console.error('[CartService._migrateLocalToSupabase] ABORT: No user available');
                return false;
            }
            if (this._localCart.length === 0) {
                console.log('[CartService._migrateLocalToSupabase] ABORT: No local items');
                return true; // Nothing to do, not a failure
            }

            // Check existing items in Supabase
            console.log('[CartService._migrateLocalToSupabase] Checking existing Supabase items...');
            const { data: existingItems, error: countErr } = await client
                .from('cart_items')
                .select('product_id, weight, quantity')
                .eq('user_id', user.id);

            if (countErr) {
                console.error('[CartService._migrateLocalToSupabase] Failed to check existing cart:', countErr);
                return false;
            }

            const hasExistingItems = (existingItems || []).length > 0;
            console.log('[CartService._migrateLocalToSupabase] Existing Supabase items:', hasExistingItems ? existingItems.length : 0);

            if (hasExistingItems) {
                console.log('[CartService._migrateLocalToSupabase] Using merge_user_cart RPC...');
                const itemsJson = JSON.stringify(this._localCart.map(item => ({
                    product_id: this._slugify(item.name),
                    product_name: item.name,
                    weight: item.weight,
                    weightInGrams: item.weightInGrams || parseWeight(item.weight),
                    price: item.price,
                    basePrice: item.basePrice || item.price,
                    quantity: item.quantity
                })));

                console.log('[CartService._migrateLocalToSupabase] RPC payload:', itemsJson);

                const { error: mergeErr } = await client.rpc('merge_user_cart', {
                    p_user_id: user.id,
                    p_items: itemsJson
                });

                if (mergeErr) {
                    console.error('[CartService._migrateLocalToSupabase] merge_user_cart RPC failed:', mergeErr);
                    console.log('[CartService._migrateLocalToSupabase] Falling back to individual upserts...');
                    const fallbackResult = await this._upsertItemsIndividually(this._localCart);
                    if (!fallbackResult) {
                        console.error('[CartService._migrateLocalToSupabase] Fallback upserts also failed');
                        return false;
                    }
                } else {
                    console.log('[CartService._migrateLocalToSupabase] RPC succeeded');
                }
            } else {
                console.log('[CartService._migrateLocalToSupabase] No existing items, using individual inserts...');
                const insertResult = await this._upsertItemsIndividually(this._localCart);
                if (!insertResult) {
                    console.error('[CartService._migrateLocalToSupabase] Individual inserts failed');
                    return false;
                }
            }

            console.log('[CartService._migrateLocalToSupabase] Migration completed successfully');
            showToast('Cart synced to your account', 'success');
            return true;
        } catch (e) {
            console.error('[CartService._migrateLocalToSupabase] Migration error:', e);
            return false;
        }
    },

    async _upsertItemsIndividually(items) {
        console.log('[CartService._upsertItemsIndividually] Starting upsert for', items.length, 'items');
        
        const client = await this._getClient();
        const user = await Account.getCurrentUser();
        
        if (!user) {
            console.error('[CartService._upsertItemsIndividually] No user available');
            return false;
        }

        let successCount = 0;
        let failCount = 0;

        for (const item of items) {
            const productId = this._slugify(item.name);
            const weightInGrams = item.weightInGrams || parseWeight(item.weight);
            
            console.log('[CartService._upsertItemsIndividually] Processing:', item.name, '-', item.weight);

            try {
                const { data: existing, error: findErr } = await client
                    .from('cart_items')
                    .select('id, quantity')
                    .eq('user_id', user.id)
                    .eq('product_id', productId)
                    .eq('weight', item.weight)
                    .single();

                if (findErr && findErr.code !== 'PGRST116') { // PGRST116 = no rows returned
                    console.error('[CartService._upsertItemsIndividually] Find error for', item.name, ':', findErr);
                    failCount++;
                    continue;
                }

                if (existing) {
                    const newQty = Math.min(existing.quantity + item.quantity, this.MAX_QTY);
                    console.log('[CartService._upsertItemsIndividually] Updating existing:', item.name, 'qty:', existing.quantity, '->', newQty);
                    
                    const { error: updErr } = await client
                        .from('cart_items')
                        .update({ quantity: newQty })
                        .eq('id', existing.id);
                        
                    if (updErr) {
                        console.error('[CartService._upsertItemsIndividually] Update failed:', updErr);
                        failCount++;
                    } else {
                        successCount++;
                    }
                } else {
                    console.log('[CartService._upsertItemsIndividually] Inserting new:', item.name);
                    
                    const { error: insErr } = await client
                        .from('cart_items')
                        .insert({
                            user_id: user.id,
                            product_id: productId,
                            product_name: item.name,
                            weight: item.weight,
                            weight_in_grams: weightInGrams,
                            price: item.price,
                            base_price: item.basePrice || item.price,
                            quantity: Math.min(item.quantity, this.MAX_QTY)
                        });
                        
                    if (insErr) {
                        console.error('[CartService._upsertItemsIndividually] Insert failed:', insErr);
                        failCount++;
                    } else {
                        successCount++;
                    }
                }
            } catch (e) {
                console.error('[CartService._upsertItemsIndividually] Exception for', item.name, ':', e);
                failCount++;
            }
        }

        console.log('[CartService._upsertItemsIndividually] Complete. Success:', successCount, 'Failed:', failCount);
        return failCount === 0; // Return true only if all succeeded
    },

    // ============================================
    // CRUD Operations (Unified Interface)
    // ============================================

    async addItem(item) {
        console.log('[CartService.addItem] Adding:', item.name, item.weight, 'qty:', item.quantity);
        if (this._isLoggedIn()) {
            await this._addToSupabase(item);
        } else {
            this._addToLocal(item);
        }
        this._notifyUpdate();
    },

    async removeItem(indexOrId) {
        console.log('[CartService.removeItem] Removing item at index/ID:', indexOrId);
        if (this._isLoggedIn()) {
            await this._removeFromSupabase(indexOrId);
        } else {
            this._removeFromLocal(indexOrId);
        }
        this._notifyUpdate();
    },

    async updateQuantity(indexOrId, change) {
        console.log('[CartService.updateQuantity] Changing qty for:', indexOrId, 'by:', change);
        if (this._isLoggedIn()) {
            await this._updateSupabaseQty(indexOrId, change);
        } else {
            this._updateLocalQty(indexOrId, change);
        }
        this._notifyUpdate();
    },

    async clearCart() {
        console.log('[CartService.clearCart] Clearing cart');
        if (this._isLoggedIn()) {
            await this._clearSupabaseCart();
        } else {
            this._clearLocalCart();
        }
        this._notifyUpdate();
    },

    // --- Local CRUD ---
    _addToLocal(item) {
        const existing = this._localCart.find(
            i => i.name === item.name && i.weight === item.weight
        );

        if (existing) {
            existing.quantity = Math.min(existing.quantity + (item.quantity || 1), this.MAX_QTY);
            console.log('[CartService._addToLocal] Updated existing:', item.name, 'new qty:', existing.quantity);
        } else {
            this._localCart.push({
                name: item.name,
                weight: item.weight,
                weightInGrams: item.weightInGrams || parseWeight(item.weight),
                price: item.price,
                basePrice: item.basePrice || item.price,
                quantity: Math.min(item.quantity || 1, this.MAX_QTY)
            });
            console.log('[CartService._addToLocal] Added new:', item.name);
        }
        this._saveLocalCart();
    },

    _removeFromLocal(index) {
        console.log('[CartService._removeFromLocal] Removing index:', index, 'item:', this._localCart[index]?.name);
        this._localCart.splice(index, 1);
        this._saveLocalCart();
    },

    _updateLocalQty(index, change) {
        this._localCart[index].quantity += change;
        console.log('[CartService._updateLocalQty] Index:', index, 'new qty:', this._localCart[index].quantity);
        if (this._localCart[index].quantity <= 0) {
            this._localCart.splice(index, 1);
        } else if (this._localCart[index].quantity > this.MAX_QTY) {
            this._localCart[index].quantity = this.MAX_QTY;
        }
        this._saveLocalCart();
    },

    // --- Supabase CRUD ---
    async _addToSupabase(item) {
        console.log('[CartService._addToSupabase] Adding to Supabase:', item.name);
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            if (!user) {
                console.warn('[CartService._addToSupabase] No user, falling back to local');
                this._addToLocal(item);
                return;
            }

            const productId = this._slugify(item.name);
            const weightInGrams = item.weightInGrams || parseWeight(item.weight);

            const { data: existing } = await client
                .from('cart_items')
                .select('id, quantity')
                .eq('user_id', user.id)
                .eq('product_id', productId)
                .eq('weight', item.weight)
                .single();

            if (existing) {
                const newQty = Math.min(existing.quantity + (item.quantity || 1), this.MAX_QTY);
                const { error } = await client
                    .from('cart_items')
                    .update({ quantity: newQty })
                    .eq('id', existing.id);
                if (error) console.warn('[CartService._addToSupabase] Update failed:', error);
            } else {
                const { error } = await client
                    .from('cart_items')
                    .insert({
                        user_id: user.id,
                        product_id: productId,
                        product_name: item.name,
                        weight: item.weight,
                        weight_in_grams: weightInGrams,
                        price: item.price,
                        base_price: item.basePrice || item.price,
                        quantity: Math.min(item.quantity || 1, this.MAX_QTY)
                    });
                if (error) console.warn('[CartService._addToSupabase] Insert failed:', error);
            }

            await this._loadSupabaseCart();
        } catch (e) {
            console.warn('[CartService._addToSupabase] Failed:', e);
        }
    },

    async _removeFromSupabase(index) {
        try {
            const item = this._supabaseCart[index];
            if (!item || !item._dbId) return;

            const client = await this._getClient();
            const { error } = await client
                .from('cart_items')
                .delete()
                .eq('id', item._dbId);

            if (error) console.warn('Delete cart item failed:', error);
            this._supabaseCart.splice(index, 1);
        } catch (e) {
            console.warn('Remove from Supabase cart failed:', e);
        }
    },

    async _updateSupabaseQty(index, change) {
        try {
            const item = this._supabaseCart[index];
            if (!item || !item._dbId) return;

            const newQty = item.quantity + change;
            const client = await this._getClient();

            if (newQty <= 0) {
                await client.from('cart_items').delete().eq('id', item._dbId);
                this._supabaseCart.splice(index, 1);
            } else {
                const cappedQty = Math.min(newQty, this.MAX_QTY);
                const { error } = await client
                    .from('cart_items')
                    .update({ quantity: cappedQty })
                    .eq('id', item._dbId);
                if (error) {
                    console.warn('Update quantity failed:', error);
                } else {
                    item.quantity = cappedQty;
                }
            }
        } catch (e) {
            console.warn('Update Supabase quantity failed:', e);
        }
    },

    async _clearSupabaseCart() {
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            if (!user) return;

            const { error } = await client
                .from('cart_items')
                .delete()
                .eq('user_id', user.id);

            if (error) console.warn('Clear cart failed:', error);
            this._supabaseCart = [];
        } catch (e) {
            console.warn('Clear Supabase cart failed:', e);
        }
    },

    // ============================================
    // Auth State Handlers
    // ============================================
    async onLogin() {
        console.log('[CartService.onLogin] ====== LOGIN DETECTED ======');
        console.log('[CartService.onLogin] Pre-login state - Local:', this._localCart.length, 'Supabase:', this._supabaseCart.length);
        
        await this._initSupabaseCart();
        
        console.log('[CartService.onLogin] Post-init state - Local:', this._localCart.length, 'Supabase:', this._supabaseCart.length);
        this._notifyUpdate();
        console.log('[CartService.onLogin] ====== LOGIN HANDLING COMPLETE ======');
    },

    async onLogout() {
        console.log('[CartService.onLogout] ====== LOGOUT DETECTED ======');
        this._supabaseCart = [];
        this._supabaseCartLoaded = false;
        this._loadLocalCart();
        this._notifyUpdate();
        console.log('[CartService.onLogout] ====== LOGOUT HANDLING COMPLETE ======');
    },

    // ============================================
    // Getters (Unified)
    // ============================================
    getItems() {
        const isLoggedIn = this._isLoggedIn();
        // FIX: If logged in but Supabase cart hasn't loaded successfully yet,
        // fall back to local cart so guest items remain visible during migration
        if (isLoggedIn && !this._supabaseCartLoaded && this._localCart.length > 0) {
            console.log('[CartService.getItems] Supabase cart not loaded yet, returning local cart');
            return this._localCart;
        }
        const items = isLoggedIn ? this._supabaseCart : this._localCart;
        if (isLoggedIn && this._localCart.length > 0 && this._supabaseCart.length === 0) {
            console.warn('[CartService.getItems] WARNING: Logged in but Supabase cart empty while local cart has', this._localCart.length, 'items. Migration may have failed.');
        }
        return items;
    },

    getTotalItems() {
        const items = this.getItems();
        return items.reduce((sum, item) => sum + item.quantity, 0);
    },

    getTotalPrice() {
        const items = this.getItems();
        return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    },

    getTotalWeight() {
        const items = this.getItems();
        return items.reduce((sum, item) => {
            const grams = item.weightInGrams || parseWeight(item.weight);
            return sum + (grams * item.quantity);
        }, 0);
    },

    isEmpty() {
        return this.getItems().length === 0;
    },

    // ============================================
    // Helpers
    // ============================================
    _slugify(name) {
        return name.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 50);
    },

    _rowToItem(row) {
        return {
            _dbId: row.id,
            name: row.product_name,
            weight: row.weight,
            weightInGrams: row.weight_in_grams,
            price: row.price,
            basePrice: row.base_price,
            quantity: row.quantity
        };
    },

    _notifyUpdate() {
        console.log('[CartService._notifyUpdate] Notifying UI update. Items:', this.getItems().length, 'Total:', this.getTotalItems());
        window.dispatchEvent(new CustomEvent('cartUpdated', {
            detail: {
                items: this.getItems(),
                totalItems: this.getTotalItems(),
                totalPrice: this.getTotalPrice()
            }
        }));
    }
};

// ============================================
// BACKWARD COMPATIBILITY WRAPPERS
// ============================================

function saveCart() {
    if (!CartService._isLoggedIn()) {
        CartService._saveLocalCart();
    }
}

function loadCart() {
    CartService._loadLocalCart();
}

function clearSavedCart() {
    CartService._clearLocalCart();
}

function updateCartUI() {
    const items = CartService.getItems();
    const totalItems = CartService.getTotalItems();
    const totalPrice = CartService.getTotalPrice();

    console.log('[updateCartUI] Updating UI. Items:', items.length, 'Total:', totalItems);

    const cartBadge = document.getElementById('cartBadge');
    if (cartBadge) cartBadge.textContent = totalItems;

    const stickyCount = document.getElementById('stickyCartCount');
    const stickyTotal = document.getElementById('stickyCartTotal');
    const stickyBtn = document.getElementById('stickyCartBtn');

    if (stickyCount) stickyCount.textContent = totalItems;
    if (stickyTotal) stickyTotal.textContent = '\u20B9' + totalPrice.toLocaleString('en-IN');
    if (stickyBtn) stickyBtn.classList.toggle('active', totalItems > 0);

    const cartItems = document.getElementById('cartItems');
    const cartTotal = document.getElementById('cartTotal');

    if (cartTotal) cartTotal.textContent = '\u20B9' + totalPrice.toLocaleString('en-IN');

    if (!cartItems) return;

    if (items.length === 0) {
        cartItems.innerHTML = `
            <div class="cart-empty">
                <div class="cart-empty-icon">&#x1F336;&#xFE0F;</div>
                <h4>Your spice box is empty</h4>
                <p>Add authentic Guntur flavors to get started</p>
            </div>
        `;
        return;
    }

    cartItems.innerHTML = items.map((item, index) => `
        <div class="cart-item">
            <div class="cart-item-info">
                <h4>${item.name}</h4>
                <span class="cart-item-weight">${item.weight}</span>
                <span class="cart-item-price">&#x20B9;${item.price} each</span>
            </div>
            <div class="cart-item-controls">
                <div class="quantity-control">
                    <button onclick="updateQuantity(${index}, -1)" aria-label="Decrease quantity"><i class="fas fa-minus"></i></button>
                    <span>${item.quantity}</span>
                    <button onclick="updateQuantity(${index}, 1)" aria-label="Increase quantity"><i class="fas fa-plus"></i></button>
                </div>
                <div class="cart-item-total">&#x20B9;${(item.price * item.quantity).toLocaleString('en-IN')}</div>
                <button class="cart-item-remove" onclick="removeFromCart(${index})" aria-label="Remove item">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');

    // --- FREE DELIVERY PROGRESS BAR ---
    const threshold = typeof CONFIG !== 'undefined' && CONFIG.DELIVERY ? CONFIG.DELIVERY.FREE_DELIVERY_THRESHOLD : 1999;
    let progressPercent = (totalPrice / threshold) * 100;
    if (progressPercent > 100) progressPercent = 100;
    
    let progressMessage = '';
    if (progressPercent >= 100) {
        progressMessage = '🎉 Congratulations! You unlocked FREE Delivery.';
    } else if (progressPercent >= 90) {
        progressMessage = `🔥 Almost there! Add just ₹${threshold - totalPrice} more.`;
    } else if (progressPercent >= 50) {
        progressMessage = `✨ You're getting closer to FREE Delivery.`;
    } else {
        progressMessage = `🛒 Keep shopping! You're on your way to FREE Delivery.`;
    }

    const progressHtml = `
        <div class="free-delivery-progress" style="background: #ffffff; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); padding: 16px; margin-bottom: 16px; position: relative;">
            
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 32px; height: 32px; border-radius: 50%; background: ${progressPercent >= 100 ? '#e6f4ea' : '#fce8e8'}; display: flex; align-items: center; justify-content: center;">
                        <i class="fas fa-truck" style="color: ${progressPercent >= 100 ? '#1e8e3e' : '#D84A3A'}; font-size: 0.9rem;"></i>
                    </div>
                    <span style="font-size: 0.95rem; font-weight: 700; color: var(--text-dark);">Free Delivery Progress</span>
                </div>
                <span style="font-size: 0.85rem; font-weight: 600; color: var(--text-gray);">₹${totalPrice} <span style="font-weight: 400; color: #999;">of</span> ₹${threshold}</span>
            </div>

            <div class="progress-bar-bg" style="width: 100%; background: #F1F5F9; height: 12px; border-radius: 6px; overflow: visible; margin-bottom: 12px; position: relative;">
                <div class="progress-bar-fill" style="position: relative; width: ${progressPercent}%; background: ${progressPercent >= 100 ? '#1e8e3e' : 'linear-gradient(90deg, #B22222, #D84A3A)'}; height: 100%; border-radius: 6px; transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1), background 0.3s ease;">
                    ${progressPercent > 0 && progressPercent < 100 ? `<div style="position: absolute; right: -6px; top: -2px; width: 16px; height: 16px; background: #fff; border: 3px solid #D84A3A; border-radius: 50%; box-shadow: 0 0 8px rgba(216, 74, 58, 0.6);"></div>` : ''}
                </div>
            </div>

            <p style="margin: 0; font-size: 0.85rem; color: ${progressPercent >= 100 ? '#1e8e3e' : 'var(--text-dark)'}; font-weight: 500; text-align: center;">
                ${progressPercent >= 100 ? '🎉 Congratulations! FREE Delivery unlocked.' : `Add <strong>₹${threshold - totalPrice}</strong> more to unlock FREE Delivery 🚚`}
            </p>
        </div>
    `;

    cartItems.insertAdjacentHTML('afterbegin', progressHtml);
}

async function addToCart(btn, productName, basePrice) {
    const card = btn.closest('.product-card');
    const activeBtn = card.querySelector('.weight-btn.active');
    const weight = activeBtn ? activeBtn.textContent : '250g';

    const products = await DB.getProducts();
    const product = products.find(p => p.name === productName);
    const finalPrice = product ? getPriceForWeight(product, weight) : Math.round((basePrice * parseWeight(weight)) / 1000);
    const weightInGrams = parseWeight(weight);

    await CartService.addItem({
        name: productName,
        weight: weight,
        weightInGrams: weightInGrams,
        price: finalPrice,
        basePrice: basePrice,
        quantity: 1
    });

    btn.innerHTML = '<i class="fas fa-check"></i> Added!';
    btn.classList.add('added');

    const cartIcon = document.querySelector('.nav-cart');
    if (cartIcon) {
        cartIcon.classList.add('cart-bounce');
        setTimeout(() => cartIcon.classList.remove('cart-bounce'), 500);
    }

    showToast(productName + ' (' + weight + ') added to cart', 'success');
    playTickSound();

    setTimeout(() => {
        btn.innerHTML = '<i class="fas fa-cart-plus"></i> Add to Cart';
        btn.classList.remove('added');
    }, 1200);
}

async function updateQuantity(index, change) {
    await CartService.updateQuantity(index, change);
}

async function removeFromCart(index) {
    await CartService.removeItem(index);
    showToast('Item removed from cart', 'info');
}

async function placeOrder() {
    if (CartService.isEmpty()) {
        showToast('Your cart is empty! Add some items first.', 'error');
        return;
    }

    if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
        await placeOrderWithAccount();
    }

    placeOrderOnWhatsApp();
}

function placeOrderOnWhatsApp() {
    const items = CartService.getItems();
    if (items.length === 0) return;

    let message = 'Hello Padmaja Home Foods \uD83D\uDC4B\n\nI want to order:\n\n';

    const emojis = ['1\uFE0F\u20E3','2\uFE0F\u20E3','3\uFE0F\u20E3','4\uFE0F\u20E3','5\uFE0F\u20E3','6\uFE0F\u20E3','7\uFE0F\u20E3','8\uFE0F\u20E3','9\uFE0F\u20E3','\uD83D\uDD1F'];
    items.forEach((item, index) => {
        const emoji = emojis[index] || (index + 1) + '.';
        message += emoji + ' ' + item.name + ' - ' + item.weight + ' x ' + item.quantity + ' = \u20B9' + (item.price * item.quantity) + '\n';
    });

    const totalPrice = CartService.getTotalPrice();
    message += '\n*Total: \u20B9' + totalPrice + '*\n\nPlease share your delivery details:\nName:\nAddress:\nPincode:\nPhone:';

    window.open('https://wa.me/' + CONFIG.WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message), '_blank');

    CartService.clearCart();
    toggleCart();
    showToast('Redirecting to WhatsApp...', 'success');
}

async function placeOrderWithAccount() {
    if (typeof Account === 'undefined' || !Account.isLoggedIn()) return;

    const user = await Account.getCurrentUser();
    if (!user) return;

    const addresses = await Account.getAddresses();
    const defaultAddress = addresses.find(a => a.is_default) || addresses[0];
    const items = CartService.getItems();

    if (items.length === 0) return;

    const orderData = {
        total_amount: CartService.getTotalPrice() * 100,
        delivery_address: defaultAddress ? {
            full_name: defaultAddress.full_name,
            phone: defaultAddress.phone,
            address_line1: defaultAddress.address_line1,
            address_line2: defaultAddress.address_line2,
            city: defaultAddress.city,
            state: defaultAddress.state,
            pincode: defaultAddress.pincode
        } : {},
        whatsapp_number: defaultAddress ? defaultAddress.phone : '',
        items: items.map(item => ({
            product_id: CartService._slugify(item.name),
            product_name: item.name,
            weight: item.weight,
            price: item.price * 100,
            quantity: item.quantity
        }))
    };

    try {
        const result = await Account.placeOrder(orderData);
        if (result.success) {
            showToast('Order saved to your account!', 'success');
        }
    } catch (e) {
        console.warn('Failed to save order to account:', e);
    }
}

async function quickOrder(btn, productName, basePrice) {
    const card = btn.closest('.product-card');
    const activeBtn = card.querySelector('.weight-btn.active');
    const weight = activeBtn ? activeBtn.textContent : '250g';

    const products = await DB.getProducts();
    const product = products.find(p => p.name === productName);
    const finalPrice = product ? getPriceForWeight(product, weight) : Math.round((basePrice * parseWeight(weight)) / 1000);

    const message = 'Hi! I want to order *' + productName + '* - ' + weight + ' (\u20B9' + finalPrice + ')\n\nPlease share delivery details:\nName:\nAddress:\nPincode:';
    window.open('https://wa.me/' + CONFIG.WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message), '_blank');
    showToast('Opening WhatsApp for ' + productName + '...', 'success');
}

// ============================================
// EVENT LISTENERS
// ============================================

window.addEventListener('cartUpdated', () => {
    console.log('[Event] cartUpdated received, calling updateCartUI');
    updateCartUI();
});

window.addEventListener('userLoggedIn', async () => {
    console.log('[Event] ====== userLoggedIn EVENT RECEIVED ======');
    await CartService.onLogin();
    console.log('[Event] ====== userLoggedIn HANDLING COMPLETE ======');
});

window.addEventListener('userLoggedOut', async () => {
    console.log('[Event] userLoggedOut received');
    await CartService.onLogout();
});

document.addEventListener('DOMContentLoaded', () => {
    console.log('[Event] DOMContentLoaded - initializing CartService');
    CartService.init();
});