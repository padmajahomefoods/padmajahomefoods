// ============================================
// SCRIPT.JS — UI Logic Only
// REFACTORED: All data operations delegated to DB module
// No direct products.json access. No global PRODUCTS/CATEGORIES.
// ============================================

// ============================================
// LOCAL STATE (UI only — no product data cached here)
// ============================================
let _productsPromise = null; // For deduping concurrent loads

// ============================================
// DATA LOADING — Delegated to DB module
// ============================================
function startProductLoad() {
    if (!_productsPromise) {
        _productsPromise = DB.getAllData()
            .then(() => true)
            .catch(err => {
                console.error('Error loading products:', err);
                showToast('Failed to load products. Please refresh.', 'error');
                return false;
            });
    }
    return _productsPromise;
}

async function loadProducts() {
    return await startProductLoad();
}

// ============================================
// PRICE HELPERS (pure functions — no data dependency)
// ============================================
function getBasePrice(product) {
    return product.price1000 || 0;
}

function getPriceForWeight(product, weightStr) {
    const w = weightStr.toLowerCase().replace('kg', 'Kg');
    if (w === '100g' && product.price100g) return product.price100g;
    if (w === '250g' && product.price250) return product.price250;
    if (w === '500g' && product.price500) return product.price500;
    if ((w === '1kg' || w === '1Kg') && product.price1000) return product.price1000;
    const grams = parseWeight(weightStr);
    const base = getBasePrice(product);
    return Math.round((base * grams) / 1000);
}

// ============================================
// LOCALSTORAGE (Cart only) — Delegated to CartService
// ============================================

// ============================================
// NAVBAR
// ============================================
window.addEventListener('scroll', function() {
    const navbar = document.getElementById('navbar');
    if (navbar) {
        navbar.classList.toggle('scrolled', window.scrollY > 30);
    }
});

function openMobileMenu() {
    const overlay = document.getElementById('mobileOverlay');
    if (overlay) {
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeMobileMenu() {
    const overlay = document.getElementById('mobileOverlay');
    if (overlay) {
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// ============================================
// CART SIDEBAR
// ============================================
function toggleCart(forceOpen) {
    const sidebar = document.getElementById('cartSidebar');
    const overlay = document.getElementById('cartOverlay');
    if (!sidebar || !overlay) return;

    const isOpen = sidebar.classList.contains('active');
    if (forceOpen === true || !isOpen) {
        sidebar.classList.add('active');
        overlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    } else {
        sidebar.classList.remove('active');
        overlay.classList.remove('active');
        document.body.style.overflow = '';
    }
}

// ============================================
// CART FUNCTIONALITY — Delegated to CartService in cart.js
// ============================================

// ============================================
// AUTH INTEGRATION — Cart & Order with Account
// ============================================

// ============================================
// QUICK ORDER (Single Product)
// ============================================
async function buyNow(btn, productId, basePrice) {
    const card = btn.closest('.product-card');
    const activeBtn = card ? card.querySelector('.weight-btn.active') : document.querySelector('.pdp-weight-options .pdp-weight-btn.active');
    
    let weight;
    if (activeBtn) {
        weight = activeBtn.dataset.weight || activeBtn.textContent.trim();
    } else {
        const products = await DB.getProducts();
        const p = products.find(p => String(p.id) === String(productId));
        weight = p ? p.default_weight : '1 kg';
    }

    const items = CartService.getItems();
    if (items.length > 0) {
        // Show conflict modal
        let modal = document.getElementById('buyNowConflictModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.className = 'auth-modal-overlay';
            modal.id = 'buyNowConflictModal';
            modal.onclick = function(e) { if(e.target === this) closeBuyNowConflictModal(); };
            modal.innerHTML = `
                <div class="auth-modal" style="max-width: 450px;">
                    <button type="button" class="auth-modal-close" onclick="closeBuyNowConflictModal()" aria-label="Close">
                        <i class="fas fa-times"></i>
                    </button>
                    <div class="auth-modal-header" style="margin-bottom: 20px;">
                        <i class="fas fa-shopping-cart" style="font-size: 2rem; color: var(--spice-red); margin-bottom: 10px;"></i>
                        <h3>Cart Not Empty</h3>
                        <p>You already have items in your cart. How would you like to proceed?</p>
                    </div>
                    <div class="auth-fields active" style="gap: 12px; margin-bottom: 0;">
                        <button type="button" class="auth-submit-btn" onclick="proceedToCheckoutWithCart()" style="background: var(--deep-brown);">
                            <i class="fas fa-cart-plus"></i> Add to Cart & Checkout All
                        </button>
                        <button type="button" class="auth-submit-btn" onclick="proceedToCheckoutSingleItem()" style="background: var(--spice-red);">
                            <i class="fas fa-bolt"></i> Buy This Item Only
                        </button>
                        <button type="button" class="auth-submit-btn" onclick="closeBuyNowConflictModal()" style="background: var(--gray-200); color: var(--text-dark); border: 1px solid var(--gray-300);">
                            Cancel
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
        // Store pending single item for checkout
        window.pendingSingleCheckout = { productId, basePrice, weight };
    } else {
        // Empty cart, go straight to checkout
        window.location.assign(`checkout.html?buy_now_product_id=${encodeURIComponent(productId)}&weight=${encodeURIComponent(weight)}`);
    }
    return false;
}

function closeBuyNowConflictModal() {
    const modal = document.getElementById('buyNowConflictModal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = '';
    }
}

async function proceedToCheckoutWithCart() {
    closeBuyNowConflictModal();
    const pending = window.pendingSingleCheckout;
    if (pending) {
        const products = await DB.getProducts();
        const p = products.find(prod => String(prod.id) === String(pending.productId));
        if (p) {
            // Find a temporary button to pass to addToCart, or just call CartService directly
            const finalPrice = getPriceForWeight(p, pending.weight);
            const weightInGrams = parseWeight(pending.weight);
            await CartService.addItem({
                name: p.name,
                weight: pending.weight,
                weightInGrams: weightInGrams,
                price: finalPrice,
                basePrice: pending.basePrice,
                quantity: 1
            });
        }
    }
    goToCheckout();
}

function proceedToCheckoutSingleItem() {
    closeBuyNowConflictModal();
    const pending = window.pendingSingleCheckout;
    if (pending) {
        window.location.assign(`checkout.html?buy_now_product_id=${encodeURIComponent(pending.productId)}&weight=${encodeURIComponent(pending.weight)}`);
    }
}

function goToCheckout() {
    window.location.assign('checkout.html');
}

// ============================================
// WEIGHT SELECTION
// ============================================
async function selectWeight(btn, weight) {
    const card = btn.closest('.product-card');
    const allBtns = card.querySelectorAll('.weight-btn');
    allBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const productName = card.getAttribute('data-product');
    const products = await DB.getProducts();
    const product = products.find(p => p.name === productName);
    const priceDisplay = card.querySelector('.product-price');
    const weightText = weight >= 1000 ? '1Kg' : weight + 'g';
    const calculatedPrice = product ? getPriceForWeight(product, weightText) : 0;

    if (priceDisplay) priceDisplay.innerHTML = '\u20B9' + calculatedPrice + ' <span>/ ' + weightText + '</span>';
}

async function getDefaultWeight(productName) {
    const products = await DB.getProducts();
    const product = products.find(p => p.name === productName);
    if (!product || !product.weights || !product.weights.length) return '250g';
    return product.weights[0];
}

function parseWeight(weightStr) {
    if (weightStr === '1Kg') return 1000;
    return parseInt(weightStr.replace('g', '')) || 250;
}

// ============================================
// CATEGORY FILTER
// ============================================
function filterCategory(category) {
    const allSections = document.querySelectorAll('.products-section');
    const allBtns = document.querySelectorAll('.filter-btn');

    allBtns.forEach(btn => btn.classList.remove('active'));
    if (event && event.target) event.target.classList.add('active');

    if (category === 'all') {
        allSections.forEach(section => section.classList.add('active'));
    } else {
        allSections.forEach(section => {
            section.classList.toggle('active', section.getAttribute('data-category') === category);
        });
    }

    const firstActive = document.querySelector('.products-section.active');
    if (firstActive) {
        const controls = document.querySelector('.shop-controls');
        const offset = controls ? controls.offsetHeight + 80 : 100;
        const top = firstActive.getBoundingClientRect().top + window.scrollY - offset;
        window.scrollTo({ top: top, behavior: 'smooth' });
    }
}

// ============================================
// SEARCH
// ============================================
async function searchProducts() {
    const input = document.getElementById('productSearch');
    const results = document.getElementById('searchResults');
    const clearBtn = document.getElementById('searchClear');
    const query = input.value.trim().toLowerCase();

    if (query.length === 0) {
        results.innerHTML = '';
        results.classList.remove('active');
        clearBtn.classList.remove('active');
        return;
    }

    clearBtn.classList.add('active');

    const matches = await DB.searchProducts(query);

    if (matches.length === 0) {
        results.innerHTML = '<div class="search-no-results">No products found</div>';
        results.classList.add('active');
        return;
    }

    results.innerHTML = matches.map(p => {
        const imgUrl = DB.getImageUrl(p.image);
        return `<div class="search-result-item" onclick="goToProduct('${p.catId}', '${p.id}')">
            <img src="${imgUrl}" alt="${p.name}" class="search-result-img" onerror="this.style.display='none';this.parentElement.querySelector('.search-fallback').style.display='flex'">
            <div class="search-fallback" style="display:none;width:40px;height:40px;background:var(--gray-100);border-radius:var(--radius-sm);align-items:center;justify-content:center;color:var(--gray-400);font-size:0.7rem;">IMG</div>
            <div>
                <div class="search-result-name">${p.name}</div>
                <div class="search-result-category">${p.category}</div>
            </div>
        </div>`;
    }).join('');

    results.classList.add('active');
}

function clearSearch() {
    const input = document.getElementById('productSearch');
    const results = document.getElementById('searchResults');
    const clearBtn = document.getElementById('searchClear');

    input.value = '';
    results.innerHTML = '';
    results.classList.remove('active');
    clearBtn.classList.remove('active');
    input.focus();
}

async function goToProduct(categoryId, productId) {
    clearSearch();
    document.querySelectorAll('.products-section').forEach(s => s.classList.add('active'));
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
        const btnCat = btn.getAttribute('data-category');
        if (btnCat === categoryId) btn.classList.add('active');
        else if (btnCat === 'all') btn.classList.add('active');
    });

    setTimeout(() => {
        const card = document.getElementById(productId);
        if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.style.animation = 'highlightProduct 1.5s ease';
            setTimeout(() => { card.style.animation = ''; }, 1500);
        }
    }, 200);
}

// ============================================
// SHARE PRODUCT
// ============================================
async function shareProduct(btn) {
    const card = btn.closest('.product-card');
    if (!card) return;

    const productName = card.getAttribute('data-product');
    const productId = card.id;
    const activeBtn = card.querySelector('.weight-btn.active');
    const weight = activeBtn ? activeBtn.textContent : await getDefaultWeight(productName);

    const priceEl = card.querySelector('.product-price');
    const priceText = priceEl ? priceEl.textContent.trim() : '';

    const shareUrl = window.location.origin + '/product.html?id=' + productId;
    const shareText = 'Check out ' + productName + ' (' + weight + ') from Padmaja Home Foods \u2014 ' + priceText + '\n\n' + shareUrl;

    if (navigator.share) {
        navigator.share({
            title: productName + ' | Padmaja Home Foods',
            text: shareText
        }).catch(() => {});
    } else {
        copyToClipboard(shareText);
        showToast('Link copied for ' + productName + '!', 'success');
    }
}

function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
    } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
    }
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type) {
    type = type || 'info';
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast ' + type;

    const icon = type === 'success' ? 'fa-check-circle' :
                 type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';

    toast.innerHTML = '<i class="fas ' + icon + '"></i> <span>' + message + '</span>';
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// ============================================
// SOUND EFFECTS
// ============================================
function playTickSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.frequency.value = 900;
        oscillator.type = 'sine';
        gainNode.gain.setValueAtTime(0.12, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + 0.08);
    } catch (e) {}
}

// ============================================
// SCROLL ANIMATIONS
// ============================================
const observerOptions = {
    threshold: 0.08,
    rootMargin: '0px 0px -40px 0px'
};

const scrollObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
            scrollObserver.unobserve(entry.target);
        }
    });
}, observerOptions);

function initScrollAnimations() {
    document.querySelectorAll('.product-card, .trust-badge, .home-feature').forEach((el, index) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(20px)';
        el.style.transition = 'opacity 0.5s ease ' + (index * 0.05) + 's, transform 0.5s ease ' + (index * 0.05) + 's';
        scrollObserver.observe(el);
    });
}

// ============================================
// PRODUCT DETAIL PAGE (PDP)
// ============================================
async function initProductPage() {
    const urlParams = new URLSearchParams(window.location.search);
    const rawProductId = urlParams.get('id');

    if (!rawProductId) {
        window.location.href = 'index.html';
        return;
    }

    const products = await DB.getProducts();
    const product = products.find(p => String(p.id) === String(rawProductId));

    if (!product) {
        window.location.href = 'index.html';
        return;
    }

    const categories = await DB.getCategories();
    const catInfo = categories.find(c => c.id === product.catId);

    document.getElementById('pdpTitle').textContent = product.name;
    document.getElementById('pdpSubtitle').textContent = product.desc;
    document.getElementById('pdpImage').src = DB.getImageUrl(product.image);
    document.getElementById('pdpImage').alt = product.name;
    document.getElementById('pdpBreadcrumbName').textContent = product.name;
    document.getElementById('pdpBreadcrumbCategory').textContent = catInfo ? catInfo.name : product.category;
    document.getElementById('pdpBreadcrumbCategory').href = 'index.html#' + product.catId;
    document.getElementById('pdpDescription').textContent = product.desc;

    // Badges
    const badgesContainer = document.getElementById('pdpBadges');
    badgesContainer.innerHTML = '';
    if (product.badge) {
        const badgeClass = product.badge === 'bestseller' ? 'badge-bestseller' :
                          product.badge === 'popular' ? 'badge-popular' :
                          product.badge === 'new' ? 'badge-new' : 'badge-premium';
        const badgeText = product.badge === 'bestseller' ? 'Best Seller' :
                         product.badge === 'popular' ? 'Popular' :
                         product.badge === 'new' ? 'New' : 'Premium';
        badgesContainer.innerHTML = '<span class="badge ' + badgeClass + '">' + badgeText + '</span>';
    }

    // Weight options
    const weightContainer = document.getElementById('pdpWeightOptions');
    weightContainer.innerHTML = product.weights.map((w, i) => {
        const price = getPriceForWeight(product, w);
        const isActive = i === 0 ? 'active' : '';
        return `
            <button class="pdp-weight-btn ${isActive}" onclick="selectPDPWeight(this, '${w}', ${price})" data-weight="${w}">
                ${w}
                <span class="w-price">\u20B9${price}</span>
            </button>
        `;
    }).join('');

    // Set initial price
    const initialWeight = product.weights[0];
    const initialPrice = getPriceForWeight(product, initialWeight);

    document.getElementById('pdpPrice').textContent = '\u20B9' + initialPrice;

    updatePDPButtons(product, product.weights[0], initialPrice);

    // Related products
    const related = (await DB.getProductsByCategory(product.catId)).filter(p => p.id !== product.id).slice(0, 4);
    const relatedContainer = document.getElementById('pdpRelated');
    if (related.length > 0 && relatedContainer) {
        relatedContainer.innerHTML = related.map(p => createProductCard(p)).join('');
    }

    document.title = product.name + ' | Padmaja Home Foods \u2014 Authentic Guntur Spices & Pickles';

    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) metaDesc.content = product.desc + ' Order ' + product.name + ' online from Padmaja Home Foods. Homemade, 100% natural, delivered across India.';
}

function selectPDPWeight(btn, weight, price) {
    const allBtns = document.querySelectorAll('.pdp-weight-btn');
    allBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    document.getElementById('pdpPrice').textContent = '\u20B9' + price;

    const rawProductId = new URLSearchParams(window.location.search).get('id');
    DB.getProducts().then(products => {
        const product = products.find(p => String(p.id) === String(rawProductId));
        if (product) {
            updatePDPButtons(product, weight, price);
        }
    });
}

function updatePDPButtons(product, weight, price) {
    const orderBtn = document.getElementById('pdpBuyNowBtn');
    const cartBtn = document.getElementById('pdpCartBtn');

    if (orderBtn) {
        orderBtn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            buyNow(orderBtn, product.id, product.price1000 || 0);
        };
    }

    if (cartBtn) {
        cartBtn.onclick = async function() {
            const weightInGrams = parseWeight(weight);

            await CartService.addItem({
                name: product.name,
                weight: weight,
                weightInGrams: weightInGrams,
                price: price,
                basePrice: getBasePrice(product),
                quantity: 1
            });

            updateCartUI();
            playTickSound();
            showToast(product.name + ' (' + weight + ') added to cart', 'success');

            cartBtn.innerHTML = '<i class="fas fa-check"></i> Added!';
            cartBtn.classList.add('added');
            setTimeout(() => {
                cartBtn.innerHTML = '<i class="fas fa-cart-plus"></i> Add to Cart';
                cartBtn.classList.remove('added');
            }, 1200);
        };
    }
}

// ============================================
// PRODUCT CARD GENERATOR
// ============================================
function createProductCard(product, isPriority) {
    const defaultWeight = product.weights[0];
    const defaultPrice = getPriceForWeight(product, defaultWeight);
    const imageUrl = DB.getImageUrl(product.image);

    const badgeHtml = product.badge ?
        '<span class="badge badge-' + product.badge + '">' +
        (product.badge === 'bestseller' ? 'Best Seller' :
         product.badge === 'popular' ? 'Popular' :
         product.badge === 'new' ? 'New' : 'Premium') +
        '</span>' : '';

    const weightButtons = product.weights.map((w, i) => {
        const grams = parseWeight(w);
        const active = i === 0 ? 'active' : '';
        return '<button class="weight-btn ' + active + '" onclick="selectWeight(this, ' + grams + ')">' + w + '</button>';
    }).join('');

    return `
        <div class="product-card" id="${product.id}" data-product="${product.name}" data-base-price="${product.price1000 || 0}">
            <a href="product.html?id=${product.id}" class="product-card-link">
                <div class="product-image">
                    <img src="${imageUrl}" alt="${product.name}" loading="${isPriority ? 'eager' : 'lazy'}" decoding="async" width="300" height="300"
                        onerror="this.onerror=null;this.src='logo.png';this.style.objectFit='contain';this.style.padding='20px'">
                    <div class="product-badges">${badgeHtml}</div>
                </div>
            </a>
            <button class="product-share-btn" onclick="shareProduct(this)" title="Share" aria-label="Share product">
                <i class="fas fa-share-alt"></i>
            </button>
            <div class="product-info">
                <a href="product.html?id=${product.id}" class="product-card-link">
                    <h4 class="product-name">${product.name}</h4>
                    <p class="product-desc">${product.desc}</p>
                    <div class="product-price-row">
                        <div class="product-price">\u20B9${defaultPrice} <span>/ ${defaultWeight}</span></div>
                    </div>
                </a>
                <div class="weight-options">${weightButtons}</div>
                <div class="product-actions">
                    <button class="btn-buy-now" onclick="event.preventDefault(); event.stopPropagation(); buyNow(this, '${product.id}', ${product.price1000 || 0})">
                        <i class="fas fa-bolt"></i> Buy Now
                    </button>
                    <button class="btn-cart" onclick="addToCart(this, '${product.name}', ${product.price1000 || 0})">
                        <i class="fas fa-cart-plus"></i> Add to Cart
                    </button>
                </div>
                <a href="product.html?id=${product.id}" class="quick-view-link">View Details \u2192</a>
            </div>
        </div>
    `;
}

// ============================================
// RENDER SHOP PAGE
// ============================================
async function renderShopPage() {
    const [categories, products] = await Promise.all([
        DB.getCategories(),
        DB.getProducts()
    ]);

    // Render filter buttons from categories
    const filterContainer = document.querySelector('.category-filter');
    if (filterContainer) {
        const activeBtn = filterContainer.querySelector('.filter-btn.active');
        const currentFilter = activeBtn ? (activeBtn.getAttribute('data-category') || 'all') : 'all';

        let html = '<button class="filter-btn ' + (currentFilter === 'all' ? 'active' : '') + '" onclick="filterCategory(\'all\')" data-category="all">All</button>';
        categories.forEach(cat => {
            html += '<button class="filter-btn ' + (currentFilter === cat.id ? 'active' : '') + '" onclick="filterCategory(\'' + cat.id + '\')" data-category="' + cat.id + '">' + cat.name + '</button>';
        });
        filterContainer.innerHTML = html;
    }

    // Render category sections from categories
    const shopContainer = document.querySelector('.shop-container');
    if (shopContainer) {
        shopContainer.innerHTML = '';
        let renderedCount = 0;

        categories.forEach(cat => {
            const catProducts = products.filter(p => p.catId === cat.id && p.available !== false);
            if (catProducts.length === 0) return;

            const section = document.createElement('section');
            section.className = 'products-section active';
            section.id = cat.id;
            section.setAttribute('data-category', cat.id);
            section.innerHTML = '<div class="section-header-row"><h3><i class="fas ' + (cat.icon || 'fa-tag') + '"></i> ' + cat.name + '</h3><span class="section-count">' + catProducts.length + ' items</span></div><div class="products-grid"></div>';
            shopContainer.appendChild(section);

            const grid = section.querySelector('.products-grid');
            if (grid) {
                grid.innerHTML = catProducts.map((p, i) => {
                    const isPriority = renderedCount < 4;
                    if (isPriority) renderedCount++;
                    return createProductCard(p, isPriority);
                }).join('');
            }
        });
    }

    initScrollAnimations();
    injectImagePreloads(products);
}

// Inject <link rel="preload"> for first 4 product images
function injectImagePreloads(products) {
    const firstFour = products.filter(p => p.available !== false).slice(0, 4);
    firstFour.forEach(p => {
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = DB.getImageUrl(p.image);
        document.head.appendChild(link);
    });
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', async function() {
    // Load app settings from DB (overrides config.js defaults)
    if (typeof SettingsService !== 'undefined' && SettingsService.loadSettings) {
        await SettingsService.loadSettings();
    }

    // Initialize cart via CartService (loaded from cart.js)
    // CartService.init() is called in cart.js DOMContentLoaded

    // Initialize customer auth
    if (typeof Account !== 'undefined') {
        await Account.init();
    }

    // Kick off product fetch immediately
    startProductLoad();

    const path = window.location.pathname;

    // FIX: Cloudflare pages drops `.html` making path `/product`
    if (path.includes('product.html') || path.includes('/product')) {
        const loaded = await loadProducts();
        if (!loaded) return;
        initProductPage();
    } else if (path.includes('index.html') || path === '/' || path.endsWith('/')) {
        const loaded = await loadProducts();
        if (!loaded) return;
        renderShopPage();
    }

    // Close search on outside click
    document.addEventListener('click', function(e) {
        const searchContainer = document.querySelector('.search-container');
        const results = document.getElementById('searchResults');
        if (searchContainer && results && !searchContainer.contains(e.target)) {
            results.classList.remove('active');
        }
    });
});

// ============================================
// HIGHLIGHT ANIMATION
// ============================================
const highlightStyle = document.createElement('style');
highlightStyle.textContent = `
    @keyframes highlightProduct {
        0% { transform: scale(1); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        25% { transform: scale(1.02); box-shadow: 0 8px 24px rgba(244, 196, 48, 0.4); }
        50% { transform: scale(1.02); box-shadow: 0 8px 24px rgba(244, 196, 48, 0.4); }
        100% { transform: scale(1); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    }
`;
document.head.appendChild(highlightStyle);