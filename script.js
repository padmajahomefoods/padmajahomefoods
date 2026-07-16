// ============================================
// SCRIPT.JS — UI Logic Only
// REFACTORED: All data operations delegated to DB module
// No direct products.json access. No global PRODUCTS/CATEGORIES.
// ============================================

// ============================================
// LOCAL STATE (UI only — no product data cached here)
// ============================================
let cart = [];
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
// LOCALSTORAGE (Cart only)
// ============================================
function saveCart() {
    localStorage.setItem(CONFIG.CART_STORAGE_KEY, JSON.stringify({ version: 2, items: cart }));
}

function loadCart() {
    const saved = localStorage.getItem(CONFIG.CART_STORAGE_KEY);
    if (saved) {
        try {
            const data = JSON.parse(saved);
            cart = (data.version === 2 ? data.items : data.version === 1 ? data.items : []) || [];
        } catch (e) {
            cart = [];
        }
    }
}

function clearSavedCart() {
    localStorage.removeItem(CONFIG.CART_STORAGE_KEY);
}

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
// CART FUNCTIONALITY
// ============================================
async function addToCart(btn, productName, basePrice) {
    const card = btn.closest('.product-card');
    const activeBtn = card.querySelector('.weight-btn.active');
    const weight = activeBtn ? activeBtn.textContent : await getDefaultWeight(productName);

    const products = await DB.getProducts();
    const product = products.find(p => p.name === productName);
    const finalPrice = product ? getPriceForWeight(product, weight) : Math.round((basePrice * parseWeight(weight)) / 1000);
    const weightInGrams = parseWeight(weight);

    const existingItem = cart.find(item => item.name === productName && item.weight === weight);

    if (existingItem) {
        if (existingItem.quantity >= 10) {
            showToast('Maximum 10 items per product', 'error');
            return;
        }
        existingItem.quantity += 1;
    } else {
        cart.push({
            name: productName,
            weight: weight,
            weightInGrams: weightInGrams,
            price: finalPrice,
            basePrice: basePrice,
            quantity: 1
        });
    }

    updateCartUI();
    saveCart();
    playTickSound();

    btn.innerHTML = '<i class="fas fa-check"></i> Added!';
    btn.classList.add('added');

    const cartIcon = document.querySelector('.nav-cart');
    if (cartIcon) {
        cartIcon.classList.add('cart-bounce');
        setTimeout(() => cartIcon.classList.remove('cart-bounce'), 500);
    }

    showToast(productName + ' (' + weight + ') added to cart', 'success');

    setTimeout(() => {
        btn.innerHTML = '<i class="fas fa-cart-plus"></i> Add to Cart';
        btn.classList.remove('added');
    }, 1200);
}

function updateQuantity(index, change) {
    cart[index].quantity += change;
    if (cart[index].quantity <= 0) {
        cart.splice(index, 1);
    }
    updateCartUI();
    saveCart();
}

function removeFromCart(index) {
    cart.splice(index, 1);
    updateCartUI();
    saveCart();
    showToast('Item removed from cart', 'info');
}

function updateCartUI() {
    const cartItems = document.getElementById('cartItems');
    const cartBadge = document.getElementById('cartBadge');
    const cartTotal = document.getElementById('cartTotal');
    const stickyCount = document.getElementById('stickyCartCount');
    const stickyTotal = document.getElementById('stickyCartTotal');
    const stickyBtn = document.getElementById('stickyCartBtn');

    const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    if (cartBadge) cartBadge.textContent = totalItems;
    if (stickyCount) stickyCount.textContent = totalItems;
    if (cartTotal) cartTotal.textContent = '\u20B9' + totalPrice.toLocaleString('en-IN');
    if (stickyTotal) stickyTotal.textContent = '\u20B9' + totalPrice.toLocaleString('en-IN');
    if (stickyBtn) stickyBtn.classList.toggle('active', totalItems > 0);

    if (!cartItems) return;

    if (cart.length === 0) {
        cartItems.innerHTML = `
            <div class="cart-empty">
                <div class="cart-empty-icon">&#x1F336;&#xFE0F;</div>
                <h4>Your spice box is empty</h4>
                <p>Add authentic Guntur flavors to get started</p>
            </div>
        `;
        return;
    }

    cartItems.innerHTML = cart.map((item, index) => `
        <div class="cart-item">
            <div class="cart-item-info">
                <h4>${item.name}</h4>
                <span class="cart-item-weight">${item.weight}</span>
                <span class="cart-item-price">\u20B9${item.price} each</span>
            </div>
            <div class="cart-item-controls">
                <div class="quantity-control">
                    <button onclick="updateQuantity(${index}, -1)" aria-label="Decrease quantity"><i class="fas fa-minus"></i></button>
                    <span>${item.quantity}</span>
                    <button onclick="updateQuantity(${index}, 1)" aria-label="Increase quantity"><i class="fas fa-plus"></i></button>
                </div>
                <div class="cart-item-total">\u20B9${(item.price * item.quantity).toLocaleString('en-IN')}</div>
                <button class="cart-item-remove" onclick="removeFromCart(${index})" aria-label="Remove item">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>
    `).join('');
}

// ============================================
// AUTH INTEGRATION — Cart & Order with Account
// ============================================

async function placeOrderWithAccount() {
    if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
        const user = await Account.getCurrentUser();
        if (user) {
            const addresses = await Account.getAddresses();
            const defaultAddress = addresses.find(a => a.is_default) || addresses[0];

            const orderData = {
                total_amount: cart.reduce((sum, item) => sum + (item.price * item.quantity), 0) * 100,
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
                items: cart.map(item => ({
                    product_id: '',
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
    }
    placeOrderOnWhatsApp();
}

function placeOrderOnWhatsApp() {
    if (cart.length === 0) {
        showToast('Your cart is empty! Add some items first.', 'error');
        return;
    }

    let message = 'Hello Padmaja Home Foods \uD83D\uDC4B\n\nI want to order:\n\n';

    const emojis = ['1\uFE0F\u20E3','2\uFE0F\u20E3','3\uFE0F\u20E3','4\uFE0F\u20E3','5\uFE0F\u20E3','6\uFE0F\u20E3','7\uFE0F\u20E3','8\uFE0F\u20E3','9\uFE0F\u20E3','\uD83D\uDD1F'];
    cart.forEach((item, index) => {
        const emoji = emojis[index] || (index + 1) + '.';
        message += emoji + ' ' + item.name + ' - ' + item.weight + ' x ' + item.quantity + ' = \u20B9' + (item.price * item.quantity) + '\n';
    });

    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    message += '\n*Total: \u20B9' + totalPrice + '*\n\nPlease share your delivery details:\nName:\nAddress:\nPincode:\nPhone:';

    window.open('https://wa.me/' + CONFIG.WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message), '_blank');

    cart = [];
    updateCartUI();
    clearSavedCart();
    toggleCart();
    showToast('Redirecting to WhatsApp...', 'success');
}

// Override original placeOrder to support account
function placeOrder() {
    if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
        placeOrderWithAccount();
    } else {
        placeOrderOnWhatsApp();
    }
}

// ============================================
// QUICK ORDER (Single Product)
// ============================================
async function quickOrder(btn, productName, basePrice) {
    const card = btn.closest('.product-card');
    const activeBtn = card.querySelector('.weight-btn.active');
    const weight = activeBtn ? activeBtn.textContent : await getDefaultWeight(productName);

    const products = await DB.getProducts();
    const product = products.find(p => p.name === productName);
    const finalPrice = product ? getPriceForWeight(product, weight) : Math.round((basePrice * parseWeight(weight)) / 1000);

    const message = 'Hi! I want to order *' + productName + '* - ' + weight + ' (\u20B9' + finalPrice + ')\n\nPlease share delivery details:\nName:\nAddress:\nPincode:';

    window.open('https://wa.me/' + CONFIG.WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message), '_blank');

    showToast('Opening WhatsApp for ' + productName + '...', 'success');
    return false;
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
    const productId = urlParams.get('id');

    if (!productId) {
        window.location.href = 'index.html';
        return;
    }

    const product = await DB.getProductById(productId);
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

    const productId = new URLSearchParams(window.location.search).get('id');
    DB.getProductById(productId).then(product => {
        if (product) {
            updatePDPButtons(product, weight, price);
        }
    });
}

function updatePDPButtons(product, weight, price) {
    const orderBtn = document.getElementById('pdpOrderBtn');
    const cartBtn = document.getElementById('pdpCartBtn');

    if (orderBtn) {
        orderBtn.onclick = function() {
            const message = 'Hi! I want to order *' + product.name + '* - ' + weight + ' (\u20B9' + price + ')\n\nPlease share delivery details:\nName:\nAddress:\nPincode:';
            window.open('https://wa.me/' + CONFIG.WHATSAPP_NUMBER + '?text=' + encodeURIComponent(message), '_blank');
            showToast('Opening WhatsApp...', 'success');
        };
    }

    if (cartBtn) {
        cartBtn.onclick = function() {
            const weightInGrams = parseWeight(weight);
            const existingItem = cart.find(item => item.name === product.name && item.weight === weight);

            if (existingItem) {
                if (existingItem.quantity >= 10) {
                    showToast('Maximum 10 items per product', 'error');
                    return;
                }
                existingItem.quantity += 1;
            } else {
                cart.push({
                    name: product.name,
                    weight: weight,
                    weightInGrams: weightInGrams,
                    price: price,
                    basePrice: getBasePrice(product),
                    quantity: 1
                });
            }

            updateCartUI();
            saveCart();
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
                    <button class="btn-whatsapp" onclick="quickOrder(this, '${product.name}', ${product.price1000 || 0})">
                        <i class="fab fa-whatsapp"></i> Order on WhatsApp
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
    loadCart();
    updateCartUI();

    // Initialize customer auth
    if (typeof Account !== 'undefined') {
        await Account.init();
    }

    // Kick off product fetch immediately
    startProductLoad();

    const path = window.location.pathname;

    if (path.includes('product.html')) {
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
