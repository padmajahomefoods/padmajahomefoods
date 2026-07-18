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
});

function handleAdminLogout() {
    if (typeof Auth !== 'undefined') {
        Auth.logout();
        window.location.href = '../index.html';
    }
}
