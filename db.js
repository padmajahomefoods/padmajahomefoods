// ============================================
// DB.JS — Data Layer Module
// All database operations abstracted here.
// UI code NEVER touches products.json or Supabase directly.
//
// To switch modes:
//   - Set CONFIG.DATA_MODE = 'supabase' or 'local' in config.js
// ============================================

// ============================================
// LOCAL ADAPTER — REMOVED (Supabase mode only)
// If you need local JSON fallback, restore from backup.
// ============================================

// ============================================
// SUPABASE ADAPTER — Full implementation
// ============================================
const SupabaseAdapter = {
    _client: null,
    _clientPromise: null,

    async _initClient() {
        if (this._client) return this._client;
        if (this._clientPromise) return this._clientPromise;

        this._clientPromise = new Promise(async (resolve, reject) => {
            try {
                // Load Supabase client from CDN
                const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
                const createClient = module.createClient || module.default?.createClient;
                if (!createClient) {
                    // Try alternative export
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

    // --- Map DB row to app product format ---
    _rowToProduct(row) {
        if (!row) return null;
        return {
            id: row.id,
            name: row.name,
            category: row.category || '',
            catId: row.cat_id || '',
            desc: row.desc || '',
            image: row.image || '',
            badge: row.badge || '',
            available: row.available !== false,
            weights: row.weights || ['250g', '500g', '1Kg'],
            price100g: row.price_100g,
            price250: row.price_250 || 0,
            price500: row.price_500 || 0,
            price1000: row.price_1000 || 0
        };
    },

    // --- Map app product to DB row format ---
    _productToRow(product) {
        return {
            id: product.id,
            name: product.name,
            category: product.category,
            cat_id: product.catId,
            desc: product.desc,
            image: product.image,
            badge: product.badge || '',
            available: product.available !== false,
            weights: product.weights || ['250g', '500g', '1Kg'],
            price_100g: product.price100g || null,
            price_250: product.price250 || 0,
            price_500: product.price500 || 0,
            price_1000: product.price1000 || 0
        };
    },

    // --- Map DB row to app category format ---
    _rowToCategory(row) {
        if (!row) return null;
        return {
            id: row.id,
            name: row.name,
            icon: row.icon || 'fa-tag',
            order: row.order || 0
        };
    },

    // --- Map app category to DB row format ---
    _categoryToRow(category) {
        return {
            id: category.id,
            name: category.name,
            icon: category.icon || 'fa-tag',
            order: category.order || 0
        };
    },

    // --- PRODUCTS ---
    async getProducts() {
        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .select('*')
            .order('name');
        if (error) throw error;
        return (data || []).map(r => this._rowToProduct(r));
    },

    async getProductById(id) {
        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .select('*')
            .eq('id', id)
            .single();
        if (error) throw error;
        return this._rowToProduct(data);
    },

    async getProductsByCategory(catId) {
        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .select('*')
            .eq('cat_id', catId)
            .eq('available', true)
            .order('name');
        if (error) throw error;
        return (data || []).map(r => this._rowToProduct(r));
    },

    async searchProducts(query) {
        const q = (query || '').trim().toLowerCase();
        if (!q) return [];
        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .select('*')
            .eq('available', true)
            .or('name.ilike.%' + q + '%,desc.ilike.%' + q + '%,category.ilike.%' + q + '%')
            .order('name');
        if (error) throw error;
        return (data || []).map(r => this._rowToProduct(r));
    },

    async addProduct(product) {
        const client = await this._getClient();
        const row = this._productToRow(product);
        const { data, error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .insert(row)
            .select()
            .single();
        if (error) throw error;
        return this._rowToProduct(data);
    },

    async updateProduct(id, updates) {
        const client = await this._getClient();
        const row = this._productToRow(updates);
        // Remove id from update payload
        delete row.id;
        const { data, error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .update(row)
            .eq('id', id)
            .select()
            .single();
        if (error) throw error;
        return this._rowToProduct(data);
    },

    async deleteProduct(id) {
        const client = await this._getClient();
        const { error } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .delete()
            .eq('id', id);
        if (error) throw error;
        return true;
    },

    // --- CATEGORIES ---
    async getCategories() {
        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.CATEGORIES)
            .select('*')
            .order('order');
        if (error) throw error;
        return (data || []).map(r => this._rowToCategory(r));
    },

    async getCategoryById(id) {
        const client = await this._getClient();
        const { data, error } = await client
            .from(CONFIG.TABLES.CATEGORIES)
            .select('*')
            .eq('id', id)
            .single();
        if (error) throw error;
        return this._rowToCategory(data);
    },

    async addCategory(category) {
        const client = await this._getClient();
        const row = this._categoryToRow(category);
        const { data, error } = await client
            .from(CONFIG.TABLES.CATEGORIES)
            .insert(row)
            .select()
            .single();
        if (error) throw error;
        return this._rowToCategory(data);
    },

    async updateCategory(id, updates) {
        const client = await this._getClient();
        const row = this._categoryToRow(updates);
        // If ID is changing, we need to handle it specially
        const newId = updates.id;
        if (newId && newId !== id) {
            // Delete old, insert new (since id is PK)
            const { error: delErr } = await client
                .from(CONFIG.TABLES.CATEGORIES)
                .delete()
                .eq('id', id);
            if (delErr) throw delErr;
            const { data, error: insErr } = await client
                .from(CONFIG.TABLES.CATEGORIES)
                .insert(row)
                .select()
                .single();
            if (insErr) throw insErr;
            // Update products referencing old cat_id
            const { error: updErr } = await client
                .from(CONFIG.TABLES.PRODUCTS)
                .update({ cat_id: newId, category: updates.name })
                .eq('cat_id', id);
            if (updErr) throw updErr;
            return this._rowToCategory(data);
        } else {
            delete row.id;
            const { data, error } = await client
                .from(CONFIG.TABLES.CATEGORIES)
                .update(row)
                .eq('id', id)
                .select()
                .single();
            if (error) throw error;
            // Update product category names
            if (updates.name) {
                await client
                    .from(CONFIG.TABLES.PRODUCTS)
                    .update({ category: updates.name })
                    .eq('cat_id', id);
            }
            return this._rowToCategory(data);
        }
    },

    async deleteCategory(id) {
        const client = await this._getClient();
        // Check for products first
        const { count, error: countErr } = await client
            .from(CONFIG.TABLES.PRODUCTS)
            .select('*', { count: 'exact', head: true })
            .eq('cat_id', id);
        if (countErr) throw countErr;
        if (count > 0) throw new Error('Cannot delete category with ' + count + ' products');

        const { error } = await client
            .from(CONFIG.TABLES.CATEGORIES)
            .delete()
            .eq('id', id);
        if (error) throw error;
        return true;
    },

    async reorderCategories(orderedIds) {
        const client = await this._getClient();
        const updates = orderedIds.map((id, i) =>
            client.from(CONFIG.TABLES.CATEGORIES)
                .update({ order: i + 1 })
                .eq('id', id)
        );
        await Promise.all(updates);
        return this.getCategories();
    },

    // --- FULL DATA ---
    async getAllData() {
        const [products, categories] = await Promise.all([
            this.getProducts(),
            this.getCategories()
        ]);
        return { version: 2, categories, products };
    },

    async setAllData(data) {
        // Not supported in Supabase mode — use individual CRUD
        throw new Error('setAllData not supported in Supabase mode. Use individual CRUD operations.');
    },

    // --- IMAGES (Supabase Storage) ---
    async uploadImage(file, onProgress) {
        const client = await this._getClient();
        const ext = file.name.split('.').pop() || 'jpg';
        const safeName = file.name.substring(0, file.name.lastIndexOf('.')) || 'image';
        const filename = safeName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '_' + Date.now() + '.' + ext;

        const { data, error } = await client.storage
            .from(CONFIG.STORAGE_BUCKET)
            .upload(filename, file, {
                cacheControl: '3600',
                upsert: false
            });
        if (error) throw error;

        const { data: urlData } = client.storage
            .from(CONFIG.STORAGE_BUCKET)
            .getPublicUrl(data.path);
        return { path: data.path, url: urlData.publicUrl };
    },

    async deleteImage(path) {
        if (!path || path.startsWith('http')) return true;
        const client = await this._getClient();
        const filename = path.replace(/^images\//, '');
        const { error } = await client.storage
            .from(CONFIG.STORAGE_BUCKET)
            .remove([filename]);
        if (error) {
            console.warn('Failed to delete image:', error);
            return false;
        }
        return true;
    },

    getImageUrl(path) {
        if (!path) return '';
        if (path.startsWith('http')) return path;
        // Construct public URL from bucket
        const bucketUrl = CONFIG.SUPABASE_URL + '/storage/v1/object/public/' + CONFIG.STORAGE_BUCKET + '/';
        return bucketUrl + path.replace(/^images\//, '');
    },

    // --- STATS ---
    async getStats() {
        const client = await this._getClient();
        const { data: statsData, error: statsErr } = await client.rpc('get_category_stats');
        if (statsErr) {
            // Fallback if RPC not available
            const { data: products, error: pErr } = await client
                .from(CONFIG.TABLES.PRODUCTS)
                .select('cat_id');
            if (pErr) throw pErr;
            const { data: categories, error: cErr } = await client
                .from(CONFIG.TABLES.CATEGORIES)
                .select('*');
            if (cErr) throw cErr;

            const stats = { total: (products || []).length, byCategory: {} };
            (categories || []).forEach(c => {
                stats.byCategory[c.id] = {
                    name: c.name,
                    count: (products || []).filter(p => p.cat_id === c.id).length
                };
            });
            return stats;
        }
        const stats = { total: 0, byCategory: {} };
        (statsData || []).forEach(row => {
            stats.byCategory[row.cat_id] = {
                name: row.cat_name,
                count: parseInt(row.product_count) || 0
            };
            stats.total += stats.byCategory[row.cat_id].count;
        });
        return stats;
    },

    clearCache() {
        // Supabase handles caching internally
    }
};

// ============================================
// DB FACADE — The only interface the UI uses
// ============================================
const DB = {
    _adapter: null,

    _getAdapter() {
        if (!this._adapter) {
            this._adapter = (CONFIG.DATA_MODE === 'supabase') ? SupabaseAdapter : LocalAdapter;
        }
        return this._adapter;
    },

    // --- PRODUCTS ---
    getProducts() {
        return this._getAdapter().getProducts();
    },

    getProductById(id) {
        return this._getAdapter().getProductById(id);
    },

    getProductsByCategory(catId) {
        return this._getAdapter().getProductsByCategory(catId);
    },

    searchProducts(query) {
        return this._getAdapter().searchProducts(query);
    },

    addProduct(product) {
        return this._getAdapter().addProduct(product);
    },

    updateProduct(id, updates) {
        return this._getAdapter().updateProduct(id, updates);
    },

    deleteProduct(id) {
        return this._getAdapter().deleteProduct(id);
    },

    // --- CATEGORIES ---
    getCategories() {
        return this._getAdapter().getCategories();
    },

    getCategoryById(id) {
        return this._getAdapter().getCategoryById(id);
    },

    addCategory(category) {
        return this._getAdapter().addCategory(category);
    },

    updateCategory(id, updates) {
        return this._getAdapter().updateCategory(id, updates);
    },

    deleteCategory(id) {
        return this._getAdapter().deleteCategory(id);
    },

    reorderCategories(orderedIds) {
        return this._getAdapter().reorderCategories(orderedIds);
    },

    // --- FULL DATA ---
    getAllData() {
        return this._getAdapter().getAllData();
    },

    setAllData(data) {
        return this._getAdapter().setAllData(data);
    },

    // --- IMAGES ---
    uploadImage(file, onProgress) {
        return this._getAdapter().uploadImage(file, onProgress);
    },

    deleteImage(path) {
        return this._getAdapter().deleteImage(path);
    },

    getImageUrl(path) {
        return this._getAdapter().getImageUrl(path);
    },

    // --- STATS ---
    getStats() {
        return this._getAdapter().getStats();
    },

    // --- CACHE ---
    clearCache() {
        return this._getAdapter().clearCache();
    },

    // --- UTILITY: Build CAT_NAMES map ---
    async buildCatNames() {
        const categories = await this.getCategories();
        const map = {};
        categories.forEach(c => { map[c.id] = c.name; });
        return map;
    },

    // --- UTILITY: Get category weights config ---
    async getCategoryWeights() {
        const categories = await this.getCategories();
        const weights = {};
        categories.forEach(c => {
            if (c.id === 'masala' || c.id === 'health-wellness') {
                weights[c.id] = ['100g', '250g', '500g', '1Kg'];
            } else {
                weights[c.id] = ['250g', '500g', '1Kg'];
            }
        });
        return weights;
    },

    // ============================================
    // SETTINGS
    // ============================================

    async loadSettings() {
        try {
            if (CONFIG.DATA_MODE === 'local') return; // Skip for local
            const client = await this._getClient();
            const { data, error } = await client.from('settings').select('*');
            
            if (error) {
                console.error('Error fetching settings:', error);
                return; // Silently fallback to config.js defaults
            }
            
            if (data && data.length > 0) {
                data.forEach(row => {
                    if (row.key === 'delivery' && row.value) {
                        const val = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
                        if (val && typeof CONFIG !== 'undefined' && CONFIG.DELIVERY) {
                            if (val.free_delivery_threshold !== undefined) CONFIG.DELIVERY.FREE_DELIVERY_THRESHOLD = val.free_delivery_threshold;
                            if (val.weight_slabs) CONFIG.DELIVERY.WEIGHT_SLABS = val.weight_slabs;
                            if (val.max_slab_charge !== undefined) CONFIG.DELIVERY.MAX_SLAB_CHARGE = val.max_slab_charge;
                        }
                    }
                });
                console.log('[DB] Settings loaded and merged successfully.');
            }
        } catch (err) {
            console.error('Failed to load settings:', err);
        }
    },
    
    async updateSetting(key, value) {
        if (CONFIG.DATA_MODE === 'local') return { success: false, message: 'Settings cannot be updated in local mode.' };
        try {
            const client = await this._getClient();
            
            const { data, error } = await client.from('settings').upsert({
                key: key,
                value: value,
                updated_at: new Date().toISOString()
            }, { onConflict: 'key' });
            
            if (error) throw error;
            return { success: true };
        } catch (err) {
            console.error('Failed to update setting:', err);
            return { success: false, message: err.message };
        }
    }
};
