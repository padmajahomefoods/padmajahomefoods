// admin/admin.js

document.addEventListener('DOMContentLoaded', async () => {
    // Check authentication on all admin pages
    if (typeof Auth !== 'undefined') {
        const isAuth = Auth.isAuthenticated();
        
        // If we're on a page other than index.html and not logged in, redirect to index.html
        const isIndex = window.location.pathname.endsWith('/admin/') || window.location.pathname.endsWith('/admin/index.html');
        if (!isAuth && !isIndex) {
            window.location.href = 'index.html';
            return;
        }
    }

    // Set active state in sidebar based on current URL
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.admin-nav a');
    
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (href && currentPath.includes(href.replace('./', ''))) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
    
    // Special case for dashboard (index.html)
    if (currentPath.endsWith('/admin/') || currentPath.endsWith('/admin/index.html')) {
        navLinks.forEach(link => {
            if (link.getAttribute('href') === 'index.html' || link.getAttribute('href') === './index.html') {
                link.classList.add('active');
            }
        });
    }

    // Initialize real-time order notifications for admins
    if (typeof Auth !== 'undefined' && Auth.isAuthenticated()) {
        initOrderNotifications();
    }
});

async function handleAdminLogout() {
    if (typeof Auth !== 'undefined') {
        // Unsubscribe from real-time notifications
        if (typeof orderSubscription !== 'undefined' && orderSubscription) {
            orderSubscription.unsubscribe();
            orderSubscription = null;
        }
        
        await Auth.logout();
        
        // Ensure any residual Supabase auth tokens are completely removed
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
                localStorage.removeItem(key);
            }
        }
        sessionStorage.clear();
        
        // Redirect to admin login page (replace avoids back-button returning here)
        window.location.replace('index.html');
    }
}

// Prevent browser Back/Forward (bfcache) from exposing the dashboard after logout
window.addEventListener('pageshow', function (event) {
    if (event.persisted || (window.performance && window.performance.navigation.type === 2)) {
        if (typeof Auth !== 'undefined' && !Auth.isAuthenticated()) {
            const isIndex = window.location.pathname.endsWith('/admin/') || window.location.pathname.endsWith('/admin/index.html');
            if (!isIndex) {
                window.location.replace('index.html');
            } else {
                // If on index.html, ensure dashboard is hidden and login is shown
                const loginScreen = document.getElementById('loginScreen');
                const dashboard = document.getElementById('dashboard');
                if (loginScreen && dashboard) {
                    dashboard.classList.remove('active');
                    loginScreen.classList.remove('hidden');
                }
            }
        }
    }
});

/**
 * Secure proxy to fetch database items as an admin, bypassing RLS safely.
 */
async function fetchAdminData(table, action = 'select', options = {}) {
    try {
        const client = await DB._getAdapter()._getClient();
        const { data: session } = await client.auth.getSession();
        
        if (!session?.session?.access_token) {
            throw new Error("No active admin session found");
        }

        const res = await fetch('/api/admin-db', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.session.access_token}`,
                'x-anon-key': typeof CONFIG !== 'undefined' ? CONFIG.SUPABASE_ANON_KEY : ''
            },
            body: JSON.stringify({
                table,
                action,
                match: options.match,
                inFilter: options.inFilter,
                order: options.order,
                payload: options.payload,
                selectColumns: options.selectColumns || '*'
            })
        });

        const result = await res.json();
        
        if (!res.ok) {
            console.error("ADMIN API RAW ERROR:", result);
            throw new Error(JSON.stringify(result));
        }

        return { data: result.data, error: null };
    } catch (err) {
        console.error(`[Admin DB Error] ${table} ${action}:`, err);
        return { data: null, error: err };
    }
}

// --- Realtime Order Notifications ---
let orderSubscription = null;

async function initOrderNotifications() {
    if (orderSubscription) return;
    if (!("Notification" in window)) return;
    
    if (Notification.permission === "default") {
        await Notification.requestPermission();
    }
    
    if (Notification.permission !== "granted") return;
    
    try {
        const client = await DB._getAdapter()._getClient();
        orderSubscription = client.channel('admin-orders-channel')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'orders' },
                (payload) => {
                    playNotificationSound();
                    showOrderNotification(payload.new);
                }
            )
            .subscribe();
    } catch (err) {
        console.error("Order notification init failed", err);
    }
}

function showOrderNotification(order) {
    const title = `New Order Placed!`;
    const total = order.total_amount ? Number(order.total_amount).toLocaleString('en-IN') : '0';
    const options = {
        body: `Order #${order.order_number} for ₹${total}`,
        icon: '../favicons/android-chrome-192x192.png',
        tag: `order-${order.id}`
    };
    
    const notification = new Notification(title, options);
    
    notification.onclick = function() {
        window.focus();
        if (!window.location.pathname.includes('orders.html')) {
            window.location.href = 'orders.html';
        } else if (typeof loadOrders === 'function') {
            loadOrders();
        }
        notification.close();
    };
}

function playNotificationSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const playTone = (freq, startTime, duration) => {
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(freq, startTime);
            gainNode.gain.setValueAtTime(0, startTime);
            gainNode.gain.linearRampToValueAtTime(0.3, startTime + 0.05);
            gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            oscillator.start(startTime);
            oscillator.stop(startTime + duration);
        };
        const now = audioCtx.currentTime;
        playTone(523.25, now, 0.4); // C5
        playTone(659.25, now + 0.15, 0.6); // E5
    } catch (e) {
        console.warn('Audio play failed', e);
    }
}
