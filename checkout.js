// ============================================
// CHECKOUT LOGIC
// ============================================

const DELIVERY_CHARGE = 0; // Configurable later

document.addEventListener('DOMContentLoaded', async () => {
    // Wait for DB and Cart to be ready if they need initialization
    // CartService.init() is usually called in script.js, but since checkout.html doesn't load script.js (it's heavy with shop logic), we'll init it here
    if (CartService && CartService.init) {
        await CartService.init();
    }

    loadOrderSummary();
    preloadCustomerData();
});

async function preloadCustomerData() {
    if (typeof AccountService !== 'undefined' && AccountService.isLoggedIn()) {
        try {
            const user = await AccountService.getCurrentUser();
            const profile = await AccountService.getProfile();
            
            if (user && user.email) {
                const emailField = document.getElementById('checkoutEmail');
                if (emailField && !emailField.value) emailField.value = user.email;
            }
            
            if (profile) {
                const fields = {
                    'checkoutName': profile.full_name,
                    'checkoutPhone': profile.phone,
                    'checkoutAddress': profile.address,
                    'checkoutCity': profile.city,
                    'checkoutState': profile.state,
                    'checkoutPincode': profile.pincode
                };
                
                for (const [id, value] of Object.entries(fields)) {
                    const el = document.getElementById(id);
                    if (el && value && !el.value) {
                        el.value = value;
                    }
                }
            }
        } catch (err) {
            console.error("Failed to preload customer data:", err);
        }
    }
}

async function loadOrderSummary() {
    const params = new URLSearchParams(window.location.search);
    const buyNowProductId = params.get('buy_now_product_id');
    const buyNowWeight = params.get('weight');

    let items = [];

    if (buyNowProductId) {
        // Single Item Mode
        const products = await DB.getProducts();
        const p = products.find(prod => String(prod.id) === String(buyNowProductId));
        
        if (p) {
            const finalPrice = getPriceForWeight(p, buyNowWeight);
            items.push({
                name: p.name,
                weight: buyNowWeight,
                price: finalPrice,
                quantity: 1,
                image: p.image || '/logo.png'
            });
        }
    } else {
        // Cart Mode
        items = CartService.getItems();
    }

    renderSummaryItems(items);
}

function renderSummaryItems(items) {
    const container = document.getElementById('checkoutItemsList');
    const subtotalEl = document.getElementById('checkoutSubtotal');
    const deliveryEl = document.getElementById('checkoutDelivery');
    const grandTotalEl = document.getElementById('checkoutGrandTotal');

    if (items.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--gray-500); padding: 20px 0;">No items to checkout.</div>';
        subtotalEl.textContent = '₹0';
        deliveryEl.textContent = '₹0';
        grandTotalEl.textContent = '₹0';
        return;
    }

    let html = '';
    let subtotal = 0;

    items.forEach(item => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        
        // Use cart.js image logic or fallback
        const imgUrl = item.image || '/logo.png';

        html += `
            <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px; padding-bottom: 15px; border-bottom: 1px solid var(--gray-100);">
                <div style="width: 50px; height: 50px; background: var(--gray-100); border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;">
                    <img src="${imgUrl}" alt="${item.name}" style="max-width: 100%; max-height: 100%; object-fit: contain;">
                </div>
                <div style="flex-grow: 1;">
                    <h4 style="font-size: 0.9rem; margin-bottom: 2px; color: var(--text-dark);">${item.name}</h4>
                    <p style="font-size: 0.8rem; color: var(--gray-500); margin: 0;">${item.weight} x ${item.quantity}</p>
                </div>
                <div style="font-weight: 600; font-size: 0.95rem; color: var(--deep-brown);">
                    ₹${itemTotal}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
    
    const grandTotal = subtotal + DELIVERY_CHARGE;

    subtotalEl.textContent = '₹' + subtotal;
    deliveryEl.textContent = DELIVERY_CHARGE === 0 ? 'Free' : '₹' + DELIVERY_CHARGE;
    grandTotalEl.textContent = '₹' + grandTotal;
}

async function handleCheckoutSubmit(e) {
    e.preventDefault();
    
    // Save delivery info back to profile if logged in
    if (typeof AccountService !== 'undefined' && AccountService.isLoggedIn()) {
        try {
            const updates = {
                full_name: document.getElementById('checkoutName').value.trim(),
                phone: document.getElementById('checkoutPhone').value.trim(),
                address: document.getElementById('checkoutAddress').value.trim(),
                city: document.getElementById('checkoutCity').value.trim(),
                state: document.getElementById('checkoutState').value.trim(),
                pincode: document.getElementById('checkoutPincode').value.trim()
            };
            await AccountService.updateProfile(updates);
        } catch (err) {
            console.error("Failed to save profile data:", err);
        }
    }

    alert('Payment integration is not yet active. This is a placeholder for the checkout flow.');
}

// Utility copied from script.js for single item mode
function getPriceForWeight(product, weightStr) {
    if (product.prices && product.prices[weightStr]) {
        return product.prices[weightStr];
    }
    const wGrams = parseWeight(weightStr);
    const base = product.price1000 || 0;
    return Math.round((base * wGrams) / 1000);
}

function parseWeight(wStr) {
    if (!wStr) return 1000;
    const s = wStr.toLowerCase().replace(' ', '');
    if (s.includes('kg')) {
        return parseFloat(s) * 1000;
    }
    return parseFloat(s);
}
