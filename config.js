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
};

Object.freeze(CONFIG);
Object.freeze(CONFIG.TABLES);