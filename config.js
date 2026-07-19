// ============================================
// CONFIGURATION — Centralized app settings
// ============================================

const CONFIG = {
    // Data source mode: 'local' | 'supabase'
    DATA_MODE: 'supabase',

    // Local data file (fallback when DATA_MODE === 'local')
    LOCAL_DATA_FILE: 'products.json',

    // Supabase credentials
    SUPABASE_URL: 'https://ndduvgiiebgqplinjaxq.supabase.co',
    SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kZHV2Z2lpZWJncXBsaW5qYXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDg0NTIsImV4cCI6MjA5OTY4NDQ1Mn0.TrvCCwWEcTnmDK4IQ_LEpY1FO_DLS-3kn08lRs6SmzU',

    // Storage bucket name for images
    STORAGE_BUCKET: 'product-images',

    // Table names
    TABLES: {
        PRODUCTS: 'products',
        CATEGORIES: 'categories',
        ORDERS: 'orders',
        ORDER_ITEMS: 'order_items',
        PROFILES: 'profiles',
        ADDRESSES: 'addresses'
    },

    // Auth
    ADMIN_SESSION_KEY: 'padmaja_admin_session',
    CUSTOMER_SESSION_KEY: 'padmaja_customer_session',
    CART_STORAGE_KEY: 'padmaja_cart',

    // WhatsApp
    WHATSAPP_NUMBER: '919381311511',

    // Cache settings (ms)
    CACHE_DURATION_MS: 5 * 60 * 1000,

    // Delivery settings
    DELIVERY: {
        FREE_DELIVERY_THRESHOLD: 1999,
        // Array of slabs: maxWeight (in grams), charge (in rupees)
        // Must be sorted by maxWeight ascending
        WEIGHT_SLABS: [
            { maxWeight: 500, charge: 59 },
            { maxWeight: 1000, charge: 89 },
            { maxWeight: 2000, charge: 129 },
            { maxWeight: 3000, charge: 169 }
        ],
        // Fallback for weights exceeding the highest slab
        MAX_SLAB_CHARGE: 249 
    }
};

Object.freeze(CONFIG);
Object.freeze(CONFIG.TABLES);
// NOTE: CONFIG.DELIVERY is deliberately left unfrozen so it can be overridden 
// dynamically by DB.loadSettings() on application start.