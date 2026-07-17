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

    // --- Constants ---
    STORAGE_KEY: CONFIG.CART_STORAGE_KEY || 'padmaja_cart',
    MAX_QTY: 10,

    // --- Initialization ---
    async init() {
        this._loadLocalCart();

        // If user is logged in, load from Supabase and migrate if needed
        if (Account.isLoggedIn()) {
            await this._initSupabaseCart();
        }

        this._notifyUpdate();
    },

    // --- Client ---
    async _getClient() {
        if (this._client) return this._client;
        const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
        const supabase = module.default || module;
        this._client = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
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
            } else {
                this._localCart = [];
            }
        } catch (e) {
            console.warn('Failed to load local cart:', e);
            this._localCart = [];
        }
    },

    _saveLocalCart() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                version: 2,
                items: this._localCart
            }));
        } catch (e) {
            console.warn('Failed to save local cart:', e);
        }
    },

    _clearLocalCart() {
        this._localCart = [];
        localStorage.removeItem(this.STORAGE_KEY);
    },

    // ============================================
    // SUPABASE (Logged-in Mode)
    // ============================================
    async _initSupabaseCart() {
        // Check if localStorage has items to migrate
        const hasLocalItems = this._localCart.length > 0;

        // Load user's cart from Supabase
        await this._loadSupabaseCart();

        // Migrate local items if any
        if (hasLocalItems) {
            await this._migrateLocalToSupabase();
        }
    },

    async _loadSupabaseCart() {
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            if (!user) {
                this._supabaseCart = [];
                return;
            }

            const { data, error } = await client
                .from('cart_items')
                .select('*')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false });

            if (error) {
                console.warn('Failed to load Supabase cart:', error);
                this._supabaseCart = [];
                return;
            }

            this._supabaseCart = (data || []).map(row => this._rowToItem(row));
        } catch (e) {
            console.warn('Error loading Supabase cart:', e);
            this._supabaseCart = [];
        }
    },

    async _migrateLocalToSupabase() {
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            if (!user || this._localCart.length === 0) return;

            // Check if user already has Supabase cart items
            const { data: existingItems, error: countErr } = await client
                .from('cart_items')
                .select('product_id, weight, quantity')
                .eq('user_id', user.id);

            if (countErr) {
                console.warn('Failed to check existing cart:', countErr);
                return;
            }

            const hasExistingItems = (existingItems || []).length > 0;

            if (hasExistingItems) {
                // Use merge function to combine carts (sums quantities, caps at 10)
                const itemsJson = JSON.stringify(this._localCart.map(item => ({
                    product_id: this._slugify(item.name),
                    product_name: item.name,
                    weight: item.weight,
                    weightInGrams: item.weightInGrams || parseWeight(item.weight),
                    price: item.price,
                    basePrice: item.basePrice || item.price,
                    quantity: item.quantity
                })));

                const { error: mergeErr } = await client.rpc('merge_user_cart', {
                    p_user_id: user.id,
                    p_items: itemsJson
                });

                if (mergeErr) {
                    console.warn('Merge cart failed:', mergeErr);
                    // Fallback: upsert individually
                    await this._upsertItemsIndividually(this._localCart);
                }
            } else {
                // No existing items - bulk insert local cart
                await this._upsertItemsIndividually(this._localCart);
            }

            // Clear localStorage after successful migration
            this._clearLocalCart();

            // Reload from Supabase to get merged data
            await this._loadSupabaseCart();

            showToast('Cart synced to your account', 'success');
        } catch (e) {
            console.warn('Cart migration error:', e);
        }
    },

    async _upsertItemsIndividually(items) {
        const client = await this._getClient();
        const user = await Account.getCurrentUser();
        if (!user) return;

        for (const item of items) {
            const productId = this._slugify(item.name);
            const weightInGrams = item.weightInGrams || parseWeight(item.weight);

            // Check if item exists
            const { data: existing } = await client
                .from('cart_items')
                .select('id, quantity')
                .eq('user_id', user.id)
                .eq('product_id', productId)
                .eq('weight', item.weight)
                .single();

            if (existing) {
                // Update quantity
                const newQty = Math.min(existing.quantity + item.quantity, this.MAX_QTY);
                await client
                    .from('cart_items')
                    .update({ quantity: newQty })
                    .eq('id', existing.id);
            } else {
                // Insert new
                await client
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
            }
        }
    },

    // ============================================
    // CRUD Operations (Unified Interface)
    // ============================================

    async addItem(item) {
        // item = { name, weight, weightInGrams, price, basePrice, quantity }
        if (this._isLoggedIn()) {
            await this._addToSupabase(item);
        } else {
            this._addToLocal(item);
        }
        this._notifyUpdate();
    },

    async removeItem(indexOrId) {
        if (this._isLoggedIn()) {
            await this._removeFromSupabase(indexOrId);
        } else {
            this._removeFromLocal(indexOrId);
        }
        this._notifyUpdate();
    },

    async updateQuantity(indexOrId, change) {
        if (this._isLoggedIn()) {
            await this._updateSupabaseQty(indexOrId, change);
        } else {
            this._updateLocalQty(indexOrId, change);
        }
        this._notifyUpdate();
    },

    async clearCart() {
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
        } else {
            this._localCart.push({
                name: item.name,
                weight: item.weight,
                weightInGrams: item.weightInGrams || parseWeight(item.weight),
                price: item.price,
                basePrice: item.basePrice || item.price,
                quantity: Math.min(item.quantity || 1, this.MAX_QTY)
            });
        }
        this._saveLocalCart();
    },

    _removeFromLocal(index) {
        this._localCart.splice(index, 1);
        this._saveLocalCart();
    },

    _updateLocalQty(index, change) {
        this._localCart[index].quantity += change;
        if (this._localCart[index].quantity <= 0) {
            this._localCart.splice(index, 1);
        } else if (this._localCart[index].quantity > this.MAX_QTY) {
            this._localCart[index].quantity = this.MAX_QTY;
        }
        this._saveLocalCart();
    },

    // --- Supabase CRUD ---
    async _addToSupabase(item) {
        try {
            const client = await this._getClient();
            const user = await Account.getCurrentUser();
            if (!user) return;

            const productId = this._slugify(item.name);
            const weightInGrams = item.weightInGrams || parseWeight(item.weight);

            // Check existing
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
                if (error) console.warn('Update cart item failed:', error);
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
                if (error) console.warn('Insert cart item failed:', error);
            }

            // Optimistic: reload from Supabase
            await this._loadSupabaseCart();
        } catch (e) {
            console.warn('Add to Supabase cart failed:', e);
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

            // Optimistic update
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
        // Called after successful login
        await this._initSupabaseCart();
        this._notifyUpdate();
    },

    async onLogout() {
        // Called on logout - switch back to localStorage
        this._supabaseCart = [];
        this._loadLocalCart();
        this._notifyUpdate();
    },

    // ============================================
    // Getters (Unified)
    // ============================================
    getItems() {
        return this._isLoggedIn() ? this._supabaseCart : this._localCart;
    },

    getTotalItems() {
        const items = this.getItems();
        return items.reduce((sum, item) => sum + item.quantity, 0);
    },

    getTotalPrice() {
        const items = this.getItems();
        return items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
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
        // Dispatch custom event for UI to listen
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
// These wrap the new CartService to keep existing UI code working
// ============================================

// Legacy cart array - now proxies to CartService
Object.defineProperty(window, 'cart', {
    get() {
        return CartService.getItems();
    },
    set(value) {
        // Prevent direct assignment - use CartService methods
        console.warn('Direct cart assignment not supported. Use CartService methods.');
    }
});

// Legacy: saveCart() - no-op for Supabase, saves for local
function saveCart() {
    if (!CartService._isLoggedIn()) {
        CartService._saveLocalCart();
    }
}

// Legacy: loadCart() - handled by CartService.init()
function loadCart() {
    CartService._loadLocalCart();
}

// Legacy: clearSavedCart()
function clearSavedCart() {
    CartService._clearLocalCart();
}

// Legacy: updateCartUI() - now listens to cartUpdated event
function updateCartUI() {
    const items = CartService.getItems();
    const totalItems = CartService.getTotalItems();
    const totalPrice = CartService.getTotalPrice();

    // Update cart badge
    const cartBadge = document.getElementById('cartBadge');
    if (cartBadge) cartBadge.textContent = totalItems;

    // Update sticky cart
    const stickyCount = document.getElementById('stickyCartCount');
    const stickyTotal = document.getElementById('stickyCartTotal');
    const stickyBtn = document.getElementById('stickyCartBtn');

    if (stickyCount) stickyCount.textContent = totalItems;
    if (stickyTotal) stickyTotal.textContent = '\u20B9' + totalPrice.toLocaleString('en-IN');
    if (stickyBtn) stickyBtn.classList.toggle('active', totalItems > 0);

    // Update cart sidebar items
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
}

// Legacy: addToCart() - now uses CartService
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

    // Visual feedback
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

// Legacy: updateQuantity()
async function updateQuantity(index, change) {
    await CartService.updateQuantity(index, change);
}

// Legacy: removeFromCart()
async function removeFromCart(index) {
    await CartService.removeItem(index);
    showToast('Item removed from cart', 'info');
}

// Legacy: placeOrder() - keep existing WhatsApp logic
async function placeOrder() {
    if (CartService.isEmpty()) {
        showToast('Your cart is empty! Add some items first.', 'error');
        return;
    }

    // Save order to account if logged in
    if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
        await placeOrderWithAccount();
    }

    placeOrderOnWhatsApp();
}

// Keep existing WhatsApp order logic
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

// Keep existing account order save logic
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

// Legacy: quickOrder()
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

// Listen for cart updates from CartService
window.addEventListener('cartUpdated', () => {
    updateCartUI();
});

// Listen for auth state changes
window.addEventListener('userLoggedIn', async () => {
    await CartService.onLogin();
});

window.addEventListener('userLoggedOut', async () => {
    await CartService.onLogout();
});

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    CartService.init();
});
