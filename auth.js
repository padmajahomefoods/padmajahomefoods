// ============================================
// AUTH.JS — Authentication Module
// Supabase Auth ONLY. No hardcoded fallback credentials.
// Username is mapped to an internal email for Supabase Auth compatibility.
// ============================================

const Auth = {
    // Internal domain used to convert username → email for Supabase Auth
    // Supabase Auth requires email or phone. We map username to a private domain.
    _INTERNAL_EMAIL_DOMAIN: 'padmajahomefoods.internal',

    _supabaseClient: null,

    async _getSupabaseClient() {
        if (this._supabaseClient) return this._supabaseClient;

        // Validate Supabase config is present and not placeholder
        if (typeof CONFIG === 'undefined') {
            console.error('CONFIG is not defined. Make sure config.js is loaded before auth.js');
            return null;
        }

        if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR_') || 
            !CONFIG.SUPABASE_ANON_KEY || CONFIG.SUPABASE_ANON_KEY.includes('YOUR_')) {
            console.error('Supabase credentials not configured in config.js. Please set SUPABASE_URL and SUPABASE_ANON_KEY.');
            return null;
        }

        try {
            this._supabaseClient = await window.getSupabaseClient();
            return this._supabaseClient;
        } catch (err) {
            console.error('Failed to initialize Supabase client in auth:', err);
            return null;
        }
    },

    // Convert username to internal email for Supabase Auth
    _usernameToEmail(username) {
        const u = (username || '').trim().toLowerCase();
        return u + '@' + this._INTERNAL_EMAIL_DOMAIN;
    },

    // --- LOGIN ---
    async login(username, password) {
        const u = (username || '').trim();
        const p = password || '';

        if (!u || !p) {
            return { success: false, message: 'Username and password are required' };
        }

        const client = await this._getSupabaseClient();
        if (!client) {
            return { 
                success: false, 
                message: 'Authentication service not available. Check Supabase configuration in config.js.' 
            };
        }

        // Convert username to internal email for Supabase Auth
        const email = this._usernameToEmail(u);

        const { data, error } = await client.auth.signInWithPassword({
            email: email,
            password: p
        });

        if (error) {
            console.error('Supabase auth error:', error.message);

            // Provide user-friendly error messages
            if (error.message.includes('Invalid login credentials')) {
                return { success: false, message: 'Invalid username or password' };
            }
            if (error.message.includes('Email not confirmed')) {
                return { success: false, message: 'Account not verified. Please check your email or contact admin.' };
            }
            if (error.message.includes('rate limit')) {
                return { success: false, message: 'Too many login attempts. Please try again later.' };
            }

            return { success: false, message: 'Login failed: ' + error.message };
        }

        if (data.session) {
            localStorage.setItem(CONFIG.ADMIN_SESSION_KEY, 'active');
            return { success: true, message: 'Logged in successfully' };
        }

        return { success: false, message: 'Login failed. Please try again.' };
    },

    // --- LOGOUT ---
    async logout() {
        const client = await this._getSupabaseClient();
        if (client) {
            await client.auth.signOut();
        }
        localStorage.removeItem(CONFIG.ADMIN_SESSION_KEY);
        return { success: true };
    },

    // --- CHECK SESSION ---
    isAuthenticated() {
        return localStorage.getItem(CONFIG.ADMIN_SESSION_KEY) === 'active';
    },

    // --- REQUIRE AUTH ---
    requireAuth() {
        if (!this.isAuthenticated()) {
            window.location.reload();
            return false;
        }
        return true;
    },

    // --- CLEAR SESSION ---
    clearSession() {
        localStorage.removeItem(CONFIG.ADMIN_SESSION_KEY);
    },

    // --- GET CURRENT USER (Supabase) ---
    async getCurrentUser() {
        const client = await this._getSupabaseClient();
        if (!client) return null;
        const { data, error } = await client.auth.getUser();
        if (error) return null;
        return data.user;
    }
};
