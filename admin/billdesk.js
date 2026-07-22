// ============================================
// PADMAJA HOME FOODS — BILL DESK
// Fetches products from ../products.json (admin-managed)
// ============================================

let PRODUCTS_DATA = {};   // { categoryName: [products] }
let CATEGORIES_DATA = []; // categories array from JSON
let billItems = [];
let _userEditedDeliveryCharge = false;

// Helpers
function showAdminToast(msg, type = 'success') {
    if (!document.getElementById('adminToastStyles')) {
        const style = document.createElement('style');
        style.id = 'adminToastStyles';
        style.textContent = `
            .admin-toast-container { position: fixed; top: 80px; right: 24px; z-index: 3000; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
            .admin-toast { pointer-events: auto; background: var(--deep-brown, #333); color: white; padding: 14px 20px; border-radius: var(--radius-md, 8px); font-weight: 500; font-size: 0.9rem; box-shadow: var(--shadow-xl, 0 10px 15px -3px rgba(0,0,0,0.1)); display: flex; align-items: center; gap: 10px; animation: toastSlide 0.3s ease forwards; max-width: 360px; word-break: break-word; margin-left: auto; transition: opacity 0.3s ease; }
            .admin-toast.success { background: var(--whatsapp-green, #1DA851); }
            .admin-toast.error { background: var(--spice-red, #E34A4A); }
            @keyframes toastSlide { from { transform: translateX(100px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        `;
        document.head.appendChild(style);
    }
    
    let c = document.getElementById('adminToastContainer');
    if (!c) {
        c = document.createElement('div');
        c.id = 'adminToastContainer';
        c.className = 'admin-toast-container';
        document.body.appendChild(c);
    }
    
    const t = document.createElement('div');
    t.className = 'admin-toast ' + type;
    t.innerHTML = (type === 'success' ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-exclamation-circle"></i>') + ' <span>' + msg + '</span>';
    c.appendChild(t);
    
    setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => t.remove(), 300);
    }, 3000);
}

function parseWeight(wStr) {
    if (!wStr) return 0;
    wStr = wStr.toLowerCase().replace(/[^0-9kg]/g, '');
    if (wStr.includes('kg')) {
        return parseFloat(wStr.replace('kg', '')) * 1000;
    } else {
        return parseFloat(wStr.replace('g', ''));
    }
}

function calculateDeliveryCharge(weightInGrams) {
    if (!CONFIG || !CONFIG.DELIVERY || !CONFIG.DELIVERY.WEIGHT_SLABS) return 0; // Fallback
    for (const slab of CONFIG.DELIVERY.WEIGHT_SLABS) {
        if (weightInGrams <= slab.maxWeight) {
            return slab.charge;
        }
    }
    return CONFIG.DELIVERY.MAX_SLAB_CHARGE;
}

// Category icon & emoji mapping (fallbacks)
const CATEGORY_ICONS = {
    "masala": "fa-mortar-pestle",
    "vegpickles": "fa-carrot",
    "nonvegpickles": "fa-drumstick-bite",
    "sweets": "fa-cookie"
};

const CATEGORY_EMOJIS = {
    "masala": "🌶️",
    "vegpickles": "🥒",
    "nonvegpickles": "🍗",
    "sweets": "🍬"
};

// Currency formatter
function formatCurrency(value) {
    return '₹' + Number(value).toFixed(2);
}

// ============================================
// CUSTOMER LINKING & AUTO-DETECT
// ============================================
let _customerSearchTimeout = null;
let _customerAutoDetectTimeout = null;

function _escapeHtml(unsafe) {
    return (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function toggleCustomerSearch() {
    const type = document.getElementById('moCustomerLinkType').value;
    const searchBox = document.getElementById('moCustomerSearchBox');
    if (type === 'existing') {
        searchBox.style.display = 'block';
        document.getElementById('moCustomerSearch').focus();
    } else {
        searchBox.style.display = 'none';
        document.getElementById('moCustomerSearch').value = '';
        document.getElementById('moCustomerResults').innerHTML = '';
        document.getElementById('moCustomerResults').style.display = 'none';
        document.getElementById('moLinkedUserId').value = '';
        document.getElementById('moLinkedCustomerType').value = 'guest';
    }
}

async function searchCustomers() {
    const query = document.getElementById('moCustomerSearch').value.trim();
    const resultsContainer = document.getElementById('moCustomerResults');
    if (query.length < 2) {
        resultsContainer.innerHTML = '';
        resultsContainer.style.display = 'none';
        return;
    }
    
    if (_customerSearchTimeout) clearTimeout(_customerSearchTimeout);
    
    _customerSearchTimeout = setTimeout(async () => {
        try {
            resultsContainer.style.display = 'block';
            resultsContainer.innerHTML = '<div style="padding: 10px; color: #666; font-size: 0.9rem;">Searching...</div>';
            
            const { data, error } = await fetchAdminData(CONFIG.TABLES.PROFILES, 'select', {
                or: `full_name.ilike.%${query}%,phone.ilike.%${query}%`
            });
            
            if (error) throw error;
            
            if (!data || data.length === 0) {
                resultsContainer.innerHTML = '<div style="padding: 10px; color: #999; font-size: 0.9rem;">No customers found.</div>';
                return;
            }
            
            let html = '';
            data.slice(0, 10).forEach(c => {
                const name = c.full_name || 'No Name';
                const phone = c.phone || 'No Phone';
                html += `
                    <div style="padding: 10px; border-bottom: 1px solid #eee; cursor: pointer; font-size: 0.9rem;" 
                         onclick="selectCustomer('${c.id}', '${name.replace(/'/g, "\\'")}', '${phone.replace(/'/g, "\\'")}')"
                         onmouseover="this.style.background='#f8f9fa'" onmouseout="this.style.background='transparent'">
                        <strong><i class="fas fa-user"></i> ${_escapeHtml(name)}</strong><br>
                        <span style="color: #666;"><i class="fas fa-phone"></i> ${_escapeHtml(phone)}</span>
                    </div>
                `;
            });
            resultsContainer.innerHTML = html;
        } catch(err) {
            console.error('Customer search failed:', err);
            resultsContainer.innerHTML = '<div style="padding: 10px; color: var(--spice-red); font-size: 0.9rem;">Search failed.</div>';
        }
    }, 300);
}

window.selectCustomer = function selectCustomer(id, name, phone) {
    document.getElementById('moLinkedUserId').value = id;
    document.getElementById('moLinkedCustomerType').value = 'registered';
    document.getElementById('moCustomerSearch').value = `${name} (${phone})`;
    document.getElementById('moCustomerResults').style.display = 'none';
    
    document.getElementById('customerName').value = name;
    if (phone && phone !== 'No Phone') {
        document.getElementById('customerMobile').value = phone;
        document.getElementById('customerAutoDetectStatus').style.display = 'none'; // Clear auto-detect if manually selected
    }
}

function handleCustomerMobileInput() {
    const mobileInput = document.getElementById('customerMobile');
    const statusSpan = document.getElementById('customerAutoDetectStatus');
    const val = mobileInput.value.trim();
    
    if (val.length >= 10) {
        if (_customerAutoDetectTimeout) clearTimeout(_customerAutoDetectTimeout);
        statusSpan.style.display = 'none';
        
        _customerAutoDetectTimeout = setTimeout(async () => {
            try {
                const { data, error } = await fetchAdminData(CONFIG.TABLES.PROFILES, 'select', {
                    match: { phone: val }
                });
                if (!error && data && data.length > 0) {
                    const c = data[0];
                    statusSpan.style.display = 'block';
                    
                    document.getElementById('moCustomerLinkType').value = 'existing';
                    document.getElementById('moLinkedUserId').value = c.id;
                    document.getElementById('moLinkedCustomerType').value = 'registered';
                    document.getElementById('moCustomerSearch').value = `${c.full_name || 'No Name'} (${c.phone})`;
                    
                    if (c.full_name && !document.getElementById('customerName').value) {
                        document.getElementById('customerName').value = c.full_name;
                    }
                }
            } catch(e) {
                console.error("Auto-detect failed:", e);
            }
        }, 300);
    } else {
        statusSpan.style.display = 'none';
        if (document.getElementById('moLinkedUserId').value && document.getElementById('moLinkedCustomerType').value === 'registered') {
            document.getElementById('moCustomerLinkType').value = 'guest';
            document.getElementById('moLinkedUserId').value = '';
            document.getElementById('moLinkedCustomerType').value = 'guest';
            document.getElementById('moCustomerSearch').value = '';
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const mobileInput = document.getElementById('customerMobile');
    if (mobileInput) {
        mobileInput.addEventListener('input', handleCustomerMobileInput);
    }
    
    const linkTypeSelect = document.getElementById('moCustomerLinkType');
    if (linkTypeSelect) {
        linkTypeSelect.addEventListener('change', toggleCustomerSearch);
    }
    
    const searchInput = document.getElementById('moCustomerSearch');
    if (searchInput) {
        searchInput.addEventListener('keyup', searchCustomers);
    }
});

// ============================================
// LOAD PRODUCTS FROM products.json
// ============================================
async function loadProducts() {
    try {
        const data = await DB.getAllData();

        if (data && data.products) {
            CATEGORIES_DATA = data.categories || [];
            const products = data.products;

            // Group products by category
            PRODUCTS_DATA = {};
            CATEGORIES_DATA.forEach(cat => {
                PRODUCTS_DATA[cat.name] = products.filter(p => p.catId === cat.id && p.available !== false);
            });
        }

        renderProducts();
    } catch (error) {
        console.error('Error loading products from Supabase:', error);
        document.getElementById('productsContainer').innerHTML = `
            <div style="text-align:center;padding:40px 20px;color:#666;">
                <div style="font-size:3rem;margin-bottom:16px;">⚠️</div>
                <h3 style="color:var(--dark);margin-bottom:8px;">Failed to load products</h3>
                <p>Ensure database connection is active.</p>
            </div>
        `;
    }
}

// ============================================
// RENDER PRODUCTS
// ============================================
function renderProducts() {
    const container = document.getElementById('productsContainer');
    let html = '';

    for (const [categoryName, items] of Object.entries(PRODUCTS_DATA)) {
        if (items.length === 0) continue;

        const catInfo = CATEGORIES_DATA.find(c => c.name === categoryName) || {};
        const icon = catInfo.icon || CATEGORY_ICONS[catInfo.id] || 'fa-tag';

        html += `
            <div class="category-section">
                <div class="category-header">
                    <i class="fas ${icon}"></i>
                    ${categoryName}
                </div>
                <div class="product-list">
        `;

        items.forEach((product, index) => {
            const productId = `${product.catId}-${index}`;
            html += `
                <div class="product-item" data-product="${productId}">
                    <div class="product-name">${product.name}</div>
                    <select class="weight-select" id="weight-${productId}">
                        ${product.weights.map(w => {
                            const price = getPriceForWeight(product, w);
                            const label = w;
                            return `<option value="${w}" data-price="${price}">${label} - ₹${price}</option>`;
                        }).join('')}
                    </select>
                    <input type="number" class="qty-input" id="qty-${productId}" value="1" min="1" max="10" step="1">
                    <button class="add-btn" onclick="addToBill('${productId}', '${product.name.replace(/'/g, "\'")}')">
                        <i class="fas fa-plus"></i> Add
                    </button>
                </div>
            `;
        });

        html += '</div></div>';
    }

    container.innerHTML = html;
}

// Get actual price for a weight from product data
function getPriceForWeight(product, weightStr) {
    const w = weightStr.toLowerCase().replace('kg', 'Kg');
    if (w === '100g' && product.price100g) return product.price100g;
    if (w === '250g' && product.price250) return product.price250;
    if (w === '500g' && product.price500) return product.price500;
    if ((w === '1kg' || w === '1Kg') && product.price1000) return product.price1000;
    // Fallback: calculate from 1kg price
    const grams = parseWeight(weightStr);
    const base = product.price1000 || 0;
    return Math.round((base * grams) / 1000);
}

function parseWeight(weightStr) {
    if (weightStr === '1Kg') return 1000;
    return parseInt(weightStr.replace('g', '')) || 250;
}

// Get current selected price for a product
function getCurrentPrice(productId) {
    const weightSelect = document.getElementById(`weight-${productId}`);
    if (!weightSelect) return 0;
    const selectedOption = weightSelect.options[weightSelect.selectedIndex];
    return parseInt(selectedOption.dataset.price) || 0;
}

// Get current weight label
function getWeightLabel(productId) {
    const weightSelect = document.getElementById(`weight-${productId}`);
    if (!weightSelect) return '250g';
    return weightSelect.value;
}

// Get category info for a product name
function getCategoryInfo(productName) {
    for (const [catName, items] of Object.entries(PRODUCTS_DATA)) {
        const product = items.find(p => p.name === productName);
        if (product) {
            const catInfo = CATEGORIES_DATA.find(c => c.name === catName) || {};
            return {
                name: catName,
                id: catInfo.id || '',
                emoji: CATEGORY_EMOJIS[catInfo.id] || '📦'
            };
        }
    }
    return { name: 'Products', id: '', emoji: '📦' };
}

// ============================================
// ADD TO BILL
// ============================================
function addToBill(productId, productName) {
    const qtyInput = document.getElementById(`qty-${productId}`);
    const qty = parseInt(qtyInput.value) || 1;
    const weightLabel = getWeightLabel(productId);
    const price = getCurrentPrice(productId);
    const total = price * qty;

    // Check if same product with same weight already exists
    const existingIndex = billItems.findIndex(item =>
        item.name === productName && item.weight === weightLabel
    );

    if (existingIndex >= 0) {
        billItems[existingIndex].qty += qty;
        billItems[existingIndex].total = billItems[existingIndex].price * billItems[existingIndex].qty;
    } else {
        billItems.push({
            id: productId,
            name: productName,
            weight: weightLabel,
            price: price,
            qty: qty,
            total: total
        });
    }

    updateCartSummary();

    // Visual feedback
    const btn = document.querySelector(`[data-product="${productId}"] .add-btn`);
    if (btn) {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Added';
        btn.style.background = '#1DA851';
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.style.background = '';
        }, 800);
    }
}

// ============================================
// REMOVE / UPDATE QUANTITY
// ============================================
function removeFromBill(index) {
    billItems.splice(index, 1);
    updateCartSummary();
}

function updateSheetQty(index, change) {
    billItems[index].qty += change;
    if (billItems[index].qty <= 0) {
        billItems.splice(index, 1);
    } else {
        billItems[index].total = billItems[index].price * billItems[index].qty;
    }
    updateCartSummary();
}

// ============================================
// UPDATE CART SUMMARY (Sticky Bar + Sheet)
// ============================================
function updateCartSummary() {
    const totalQty = billItems.reduce((sum, item) => sum + item.qty, 0);
    const productsTotal = billItems.reduce((sum, item) => sum + item.total, 0);
    
    // Auto-calculate delivery if not manually edited
    const deliveryInput = document.getElementById('deliveryCharge');
    if (!_userEditedDeliveryCharge) {
        const threshold = (typeof CONFIG !== 'undefined' && CONFIG.DELIVERY) ? CONFIG.DELIVERY.FREE_DELIVERY_THRESHOLD : 1999;
        if (productsTotal >= threshold) {
            deliveryInput.value = 0;
        } else {
            const totalWeightGrams = billItems.reduce((sum, item) => sum + (parseWeight(item.weight) * item.qty), 0);
            deliveryInput.value = calculateDeliveryCharge(totalWeightGrams);
        }
    }
    
    const deliveryCharge = parseFloat(deliveryInput.value) || 0;
    const grandTotal = productsTotal + deliveryCharge;

    // Update Sticky Bar
    const stickyBar = document.getElementById('stickyCartBar');
    const stickyBadge = document.getElementById('stickyCartBadge');
    const stickyItems = document.getElementById('stickyCartItems');
    const stickyTotal = document.getElementById('stickyCartTotal');

    if (totalQty > 0) {
        stickyBar.classList.add('active');
        stickyBadge.textContent = totalQty;
        stickyItems.textContent = totalQty === 1 ? '1 item' : `${totalQty} items`;
        stickyTotal.textContent = formatCurrency(grandTotal);
    } else {
        stickyBar.classList.remove('active');
    }

    // Update Sheet
    const sheetItems = document.getElementById('cartSheetItems');
    const sheetEmpty = document.getElementById('cartSheetEmpty');
    const sheetProductsTotal = document.getElementById('sheetProductsTotal');
    const sheetDeliveryCharge = document.getElementById('sheetDeliveryCharge');
    const sheetGrandTotal = document.getElementById('sheetGrandTotal');
    const sheetShowBillBtn = document.getElementById('sheetShowBillBtn');

    sheetProductsTotal.textContent = formatCurrency(productsTotal);
    sheetDeliveryCharge.textContent = formatCurrency(deliveryCharge);
    sheetGrandTotal.textContent = formatCurrency(grandTotal);

    if (billItems.length === 0) {
        sheetItems.style.display = 'none';
        sheetEmpty.classList.add('active');
        sheetShowBillBtn.disabled = true;
    } else {
        sheetItems.style.display = 'block';
        sheetEmpty.classList.remove('active');
        sheetShowBillBtn.disabled = false;

        sheetItems.innerHTML = billItems.map((item, index) => {
            const catInfo = getCategoryInfo(item.name);
            return `
                <div class="sheet-item">
                    <div class="sheet-item-image">${catInfo.emoji}</div>
                    <div class="sheet-item-details">
                        <div class="sheet-item-name">${item.name}</div>
                        <div class="sheet-item-meta">${item.weight} @ ₹${item.price}</div>
                    </div>
                    <div class="sheet-item-qty-control">
                        <button onclick="updateSheetQty(${index}, -1)" aria-label="Decrease quantity">
                            <i class="fas fa-minus"></i>
                        </button>
                        <span>${item.qty}</span>
                        <button onclick="updateSheetQty(${index}, 1)" aria-label="Increase quantity">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>
                    <div class="sheet-item-price">₹${item.total}</div>
                    <button class="sheet-item-remove" onclick="removeFromBill(${index})" aria-label="Remove item">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </div>
            `;
        }).join('');
    }
}

// ============================================
// CART SHEET CONTROLS
// ============================================
function openCartSheet() {
    document.getElementById('cartSheetOverlay').classList.add('active');
    document.getElementById('cartSheet').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeCartSheet() {
    document.getElementById('cartSheetOverlay').classList.remove('active');
    document.getElementById('cartSheet').classList.remove('active');
    document.body.style.overflow = '';
}

// ============================================
// SHOW BILL MODAL
// ============================================
function showBill() {
    closeCartSheet();
    const customerName = document.getElementById('customerName').value.trim() || 'Customer';
    const deliveryCharge = parseFloat(document.getElementById('deliveryCharge').value) || 0;
    const billModal = document.getElementById('billModal');
    const billCustomer = document.getElementById('billCustomer');
    const billItemsContainer = document.getElementById('billItems');
    const billProductsTotal = document.getElementById('billProductsTotal');
    const billDeliveryCharge = document.getElementById('billDeliveryCharge');
    const billTotalAmount = document.getElementById('billTotalAmount');
    const billDate = document.getElementById('billDate');

    // Set date
    const now = new Date();
    billDate.textContent = now.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

    // Set customer
    billCustomer.innerHTML = `<p>Customer: <span>${customerName}</span></p>`;

    // Render bill items
    let productsTotal = 0;
    billItemsContainer.innerHTML = billItems.map(item => {
        productsTotal += item.total;
        return `
            <div class="bill-item">
                <div class="bill-item-name">
                    <strong>${item.name}</strong>
                    <span>${item.weight} × ${item.qty} @ ₹${item.price}</span>
                </div>
                <div class="bill-item-price">₹${item.total}</div>
            </div>
        `;
    }).join('');

    const grandTotal = productsTotal + deliveryCharge;
    billProductsTotal.textContent = formatCurrency(productsTotal);
    billDeliveryCharge.textContent = formatCurrency(deliveryCharge);
    billTotalAmount.textContent = formatCurrency(grandTotal);

    billModal.classList.add('active');
}

// ============================================
// CLOSE / PRINT / SHARE BILL
// ============================================
function closeBill() {
    document.getElementById('billModal').classList.remove('active');
}

function printBill() {
    window.print();
}

function shareBill() {
    const customerName = document.getElementById('customerName').value.trim() || 'Customer';
    const deliveryCharge = parseFloat(document.getElementById('deliveryCharge').value) || 0;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    });

    let productsTotal = 0;
    billItems.forEach(function(item) {
        productsTotal += item.total;
    });
    const grandTotal = productsTotal + deliveryCharge;

    let message = 'PADMAJA HOME FOODS\n';
    message += '==================\n\n';
    message += 'Date: ' + dateStr + '\n';
    message += 'Customer: ' + customerName + '\n\n';
    message += 'BILL DETAILS\n';
    message += '------------\n';

    billItems.forEach(function(item, index) {
        const num = (index + 1) + '.';
        message += num + ' ' + item.name + ' (' + item.weight + ') x' + item.qty + ' = Rs.' + item.total + '\n';
    });

    message += '\n------------\n';
    message += 'Products Total: Rs.' + productsTotal.toFixed(2) + '\n';
    message += 'Delivery Charge: Rs.' + deliveryCharge.toFixed(2) + '\n';
    message += 'Grand Total: Rs.' + grandTotal.toFixed(2) + '\n';
    message += '==================\n\n';
    message += '📞 +91 93813 11511\n';
    message += '✉️ contactpadmajahomefoods@gmail.com\n\n';
    message += 'Thank you for choosing Padmaja Home Foods ❤️';

    const encodedMessage = encodeURIComponent(message);
    window.open('https://wa.me/?text=' + encodedMessage, '_blank');
}

// ============================================
// INITIALIZE
// ============================================
document.addEventListener('DOMContentLoaded', async function() {
    if (typeof SettingsService !== 'undefined' && SettingsService.loadSettings) {
        await SettingsService.loadSettings();
    }
    loadProducts();
    const deliveryInput = document.getElementById('deliveryCharge');
    if (deliveryInput) {
        deliveryInput.addEventListener('input', function() {
            _userEditedDeliveryCharge = true;
            updateCartSummary();
        });
    }
});

// ============================================
// MANUAL ORDER SAVING LOGIC
// ============================================

function openManualOrderModal() {
    if (billItems.length === 0) {
        alert("Please add products to the bill first.");
        return;
    }
    const customerName = document.getElementById('customerName').value.trim();
    if (!customerName) {
        alert("Please enter Customer Name.");
        return;
    }
    
    // Set default date to now if empty
    const dateInput = document.getElementById('moDate');
    if (!dateInput.value) {
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
        dateInput.value = now.toISOString().slice(0, 16);
    }

    document.getElementById('manualOrderModal').style.display = 'flex';
}

function closeManualOrderModal() {
    document.getElementById('manualOrderModal').style.display = 'none';
}

async function saveManualOrder() {
    const btn = document.getElementById('moSaveBtn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

    try {
        const customerName = document.getElementById('customerName').value.trim();
        const mobile = document.getElementById('customerMobile').value.trim();
        const city = document.getElementById('customerCity').value.trim();
        const address = document.getElementById('customerAddress').value.trim();
        
        const source = document.getElementById('moSource').value;
        const method = document.getElementById('moPaymentMethod').value;
        const status = document.getElementById('moPaymentStatus').value;
        const orderStatus = document.getElementById('moOrderStatus').value;
        let orderDate = document.getElementById('moDate').value;
        const notes = document.getElementById('moNotes').value.trim();

        if (!orderDate) orderDate = new Date().toISOString();
        else orderDate = new Date(orderDate).toISOString();

        // Calculate totals
        let subtotal = 0;
        let totalWeight = 0;
        
        const itemsPayload = [];
        billItems.forEach(item => {
            const rowTotal = item.qty * item.price;
            subtotal += rowTotal;
            totalWeight += parseWeight(item.weight) * item.qty;
            
            itemsPayload.push({
                product_id: item.id,
                product_name: item.name,
                weight: item.weight,
                price: item.price,
                quantity: item.qty,
                total: rowTotal
            });
        });

        const deliveryCharge = parseFloat(document.getElementById('deliveryCharge').value) || 0;
        const grandTotal = subtotal + deliveryCharge;

        // Generate Order ID based on standard timestamp logic to match website orders perfectly
        const orderNumber = 'PHF' + Date.now();

        const addressObj = {
            full_name: customerName,
            phone: mobile,
            address_line1: address,
            city: city,
            pincode: '',
            state: 'Andhra Pradesh'
        };

        const generatedNotes = `${customerName || 'Guest Customer'} | | ${mobile} | Payment: ${method} - ${status}`;

        const linkType = document.getElementById('moCustomerLinkType') ? document.getElementById('moCustomerLinkType').value : 'guest';
        const linkedUserId = document.getElementById('moLinkedUserId') ? document.getElementById('moLinkedUserId').value : '';
        const linkedCustomerType = document.getElementById('moLinkedCustomerType') ? document.getElementById('moLinkedCustomerType').value : 'guest';

        // 0. Duplicate Protection
        try {
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            
            const { data: todaysOrders } = await fetchAdminData(CONFIG.TABLES.ORDERS, 'select', {
                 match: { total_amount: grandTotal }
            });
            
            if (todaysOrders) {
                const similar = todaysOrders.find(o => {
                    const isToday = o.created_at && o.created_at.startsWith(today);
                    if (!isToday) return false;
                    
                    if (linkType === 'existing' && linkedUserId) {
                        return o.user_id === linkedUserId;
                    } else {
                        return o.delivery_address && o.delivery_address.full_name === customerName;
                    }
                });
                
                if (similar) {
                    if (!confirm("A similar manual order already exists for this customer today.\n\nSave anyway?")) {
                        btn.disabled = false;
                        btn.innerHTML = '<i class="fas fa-check"></i> Save Order';
                        return; // Abort
                    }
                }
            }
        } catch(e) {
            console.error("Duplicate check failed, proceeding anyway", e);
        }

        const orderPayload = {
            order_number: orderNumber,
            total_amount: grandTotal,
            delivery_address: addressObj,
            status: orderStatus,
            razorpay_order_id: null,
            payment_id: null,
            is_test_order: false,
            order_source: source,
            accounting_notes: notes,
            notes: generatedNotes,
            created_at: orderDate,
            
            // Metadata for CRM
            user_id: (linkType === 'existing' && linkedUserId) ? linkedUserId : null,
            customer_type: linkedCustomerType,
            linked_by_admin: linkType === 'existing'
        };

        console.log("SENDING PAYLOAD TO DB:", JSON.stringify(orderPayload, null, 2));
        
        // Pseudo-atomic logic: Insert Order, if success insert Items, if items fail rollback Order
        const orderRes = await fetchAdminData(CONFIG.TABLES.ORDERS, 'insert', { payload: orderPayload });
        
        if (orderRes.error) {
            console.error("Orders Insert Backend Error:", orderRes.error);
            let errorMsg = orderRes.error.message || orderRes.error;
            try {
                // Try parsing the stringified error JSON for a cleaner display
                const parsed = JSON.parse(errorMsg);
                errorMsg = JSON.stringify(parsed, null, 2);
            } catch(e) {}
            throw new Error(`Order Insert Failed:\n${errorMsg}`);
        }

        if (orderRes.data && orderRes.data.length > 0) {
            const newOrderId = orderRes.data[0].id;
            
            // Assign order_id to items
            itemsPayload.forEach(i => i.order_id = newOrderId);
            
            // 1. DATABASE LOGIC ONLY
            try {
                const itemsRes = await fetchAdminData(CONFIG.TABLES.ORDER_ITEMS, 'insert', { payload: itemsPayload });
                if (itemsRes.error) {
                    throw itemsRes.error;
                }
            } catch (err) {
                // Rollback Order
                console.error('Order items failed, rolling back order', err);
                let errorMsg = err.message || err;
                try {
                    const parsed = JSON.parse(errorMsg);
                    errorMsg = JSON.stringify(parsed, null, 2);
                } catch(e) {}
                await fetchAdminData(CONFIG.TABLES.ORDERS, 'delete', { match: { id: newOrderId } });
                throw new Error(`Failed to save order items. Order rolled back.\nDetails: ${errorMsg}`);
            }

            // 2. UI SUCCESS WORKFLOW
            try {
                closeManualOrderModal();
                showAdminToast('Order Saved Successfully', 'success');
                
                if (typeof loadOrders === 'function') {
                    loadOrders();
                }
                
                // Clear all input fields
                document.getElementById('customerName').value = '';
                document.getElementById('customerMobile').value = '';
                document.getElementById('customerCity').value = '';
                document.getElementById('customerAddress').value = '';
                document.getElementById('moNotes').value = '';
                
                // Reset cart state
                billItems = [];
                _userEditedDeliveryCharge = false;
                document.getElementById('deliveryCharge').value = 0;
                
                // Update UI correctly for the bill desk
                if (typeof updateCartSummary === 'function') updateCartSummary();
                if (typeof closeBill === 'function') closeBill(); 
                
            } catch (uiErr) {
                console.error("Non-fatal UI error during cleanup:", uiErr);
            }
        } else {
            throw new Error('Failed to create order record. No data returned.');
        }
        
    } catch (error) {
        console.error(error);
        alert('Error saving manual order: ' + error.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-check"></i> Save Order';
    }
}
