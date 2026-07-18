// ============================================
// CHECKOUT LOGIC — Razorpay Integration
// ============================================

const DELIVERY_CHARGE = 0; // Configurable later

// Track current checkout items globally so handleCheckoutSubmit can access them
let _checkoutItems = [];
let _checkoutGrandTotal = 0;

document.addEventListener('DOMContentLoaded', async () => {
    // CartService.init() is usually called in script.js, but checkout.html doesn't load script.js
    if (CartService && CartService.init) {
        await CartService.init();
    }

    await loadOrderSummary();
    preloadCustomerData();
});

async function preloadCustomerData() {
    if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
        try {
            const user = await Account.getCurrentUser();
            const profile = await Account.getProfile();
            const addresses = await Account.getAddresses();

            if (user && user.email) {
                const emailField = document.getElementById('checkoutEmail');
                if (emailField && !emailField.value) emailField.value = user.email;
            }

            // Full name and phone can come from profile or metadata
            const fullName = profile?.full_name || user?.user_metadata?.full_name || '';
            const phone = profile?.phone || user?.user_metadata?.phone || '';

            const nameField = document.getElementById('checkoutName');
            if (nameField && fullName && !nameField.value) nameField.value = fullName;

            const phoneField = document.getElementById('checkoutPhone');
            if (phoneField && phone && !phoneField.value) phoneField.value = phone;

            // Address details come from the first saved address (default)
            if (addresses && addresses.length > 0) {
                const defaultAddress = addresses[0];
                const fields = {
                    'checkoutAddress': defaultAddress.address_line1 + (defaultAddress.address_line2 ? ', ' + defaultAddress.address_line2 : ''),
                    'checkoutCity': defaultAddress.city,
                    'checkoutState': defaultAddress.state,
                    'checkoutPincode': defaultAddress.pincode
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
                product_id: p.id,
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

    _checkoutItems = items;
    renderSummaryItems(items);
}

function renderSummaryItems(items) {
    const container = document.getElementById('checkoutItemsList');
    const subtotalEl = document.getElementById('checkoutSubtotal');
    const deliveryEl = document.getElementById('checkoutDelivery');
    const grandTotalEl = document.getElementById('checkoutGrandTotal');
    const payBtnText = document.getElementById('payButtonText');

    if (items.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--gray-500); padding: 20px 0;">No items to checkout.</div>';
        subtotalEl.textContent = '₹0';
        deliveryEl.textContent = '₹0';
        grandTotalEl.textContent = '₹0';
        if (payBtnText) payBtnText.textContent = 'Pay Now';
        return;
    }

    let html = '';
    let subtotal = 0;

    items.forEach(item => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;

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
    _checkoutGrandTotal = grandTotal;

    subtotalEl.textContent = '₹' + subtotal;
    deliveryEl.textContent = DELIVERY_CHARGE === 0 ? 'Free' : '₹' + DELIVERY_CHARGE;
    grandTotalEl.textContent = '₹' + grandTotal;

    if (payBtnText) payBtnText.textContent = 'Pay ₹' + grandTotal;
}

// ============================================
// PAYMENT FLOW
// ============================================

async function handleCheckoutSubmit(e) {
    e.preventDefault();

    if (_checkoutItems.length === 0) {
        showCheckoutError('Your cart is empty. Please add items before checking out.');
        return;
    }

    const payButton = document.getElementById('payButton');
    const payBtnText = document.getElementById('payButtonText');

    // Collect form data
    const customerName = document.getElementById('checkoutName').value.trim();
    const customerEmail = document.getElementById('checkoutEmail').value.trim();
    const customerPhone = document.getElementById('checkoutPhone').value.trim();
    const addressLine = document.getElementById('checkoutAddress').value.trim();
    const city = document.getElementById('checkoutCity').value.trim();
    const state = document.getElementById('checkoutState').value.trim();
    const pincode = document.getElementById('checkoutPincode').value.trim();

    const deliveryAddress = `${addressLine}, ${city}, ${state} - ${pincode}`;

    // Save address to profile if logged in (existing logic)
    if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
        try {
            await Account.updateProfile({ full_name: customerName, phone: customerPhone });

            const addresses = await Account.getAddresses();
            const isDuplicate = addresses.some(addr =>
                addr.address_line1.toLowerCase() === addressLine.toLowerCase() &&
                addr.city.toLowerCase() === city.toLowerCase() &&
                addr.pincode === pincode
            );

            if (!isDuplicate) {
                await Account.addAddress({
                    label: 'Checkout Address',
                    full_name: customerName,
                    phone: customerPhone,
                    address_line1: addressLine,
                    city: city,
                    state: state,
                    pincode: pincode,
                    is_default: addresses.length === 0
                });
            }
        } catch (err) {
            console.error("Failed to save profile data:", err);
        }
    }

    // --- Step 1: Create Razorpay order via backend ---
    payButton.disabled = true;
    payBtnText.textContent = 'Processing...';

    let orderData;
    try {
        const res = await fetch('/api/create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                amount: _checkoutGrandTotal,
                currency: 'INR',
                receipt: 'rcpt_' + Date.now(),
                customer_name: customerName,
                customer_email: customerEmail,
                customer_phone: customerPhone,
            }),
        });

        orderData = await res.json();

        if (!orderData.success) {
            throw new Error(orderData.message || 'Failed to create order');
        }
    } catch (err) {
        console.error('Create order failed:', err);
        showCheckoutError('Could not initiate payment. Please try again.');
        payButton.disabled = false;
        payBtnText.textContent = 'Pay ₹' + _checkoutGrandTotal;
        return;
    }

    // --- Step 2: Open Razorpay checkout modal ---
    const options = {
        key: orderData.key_id,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'Padmaja Home Foods',
        description: 'Order Payment',
        image: '/logo.png',
        order_id: orderData.order_id,
        prefill: {
            name: customerName,
            email: customerEmail,
            contact: customerPhone,
        },
        theme: {
            color: '#6B3A2A', // deep-brown
        },
        handler: async function (response) {
            // --- Step 3: Verify payment on backend ---
            payBtnText.textContent = 'Verifying...';

            try {
                // Determine user_id for the order (null for guests)
                let userId = null;
                if (typeof Account !== 'undefined' && Account.isLoggedIn()) {
                    const user = await Account.getCurrentUser();
                    if (user) userId = user.id;
                }

                const verifyRes = await fetch('/api/verify-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_signature: response.razorpay_signature,
                        items: _checkoutItems.map(item => ({
                            product_id: item.product_id || item.id || '',
                            name: item.name || item.product_name || '',
                            weight: item.weight || '',
                            price: item.price,
                            quantity: item.quantity,
                        })),
                        delivery_address: deliveryAddress,
                        total_amount: _checkoutGrandTotal,
                        customer: {
                            user_id: userId,
                            name: customerName,
                            email: customerEmail,
                            phone: customerPhone,
                        },
                    }),
                });

                const verifyData = await verifyRes.json();
                console.log('verify-payment response:', verifyRes.status, verifyData);

                if (verifyData.success) {
                    // Clear cart after successful payment
                    if (typeof CartService !== 'undefined' && CartService.clearCart) {
                        CartService.clearCart();
                    }

                    // Redirect to success page
                    window.location.assign(
                        `order-success.html?order=${encodeURIComponent(verifyData.order_number)}&payment=${encodeURIComponent(response.razorpay_payment_id)}`
                    );
                } else {
                    showCheckoutError('Payment was received but verification failed. Please contact support. Ref: ' + response.razorpay_payment_id);
                    payButton.disabled = false;
                    payBtnText.textContent = 'Pay ₹' + _checkoutGrandTotal;
                }
            } catch (err) {
                console.error('Verify payment failed:', err);
                showCheckoutError('Payment was received but we could not verify it. Please contact support with payment ID: ' + response.razorpay_payment_id);
                payButton.disabled = false;
                payBtnText.textContent = 'Pay ₹' + _checkoutGrandTotal;
            }
        },
        modal: {
            ondismiss: function () {
                payButton.disabled = false;
                payBtnText.textContent = 'Pay ₹' + _checkoutGrandTotal;
            },
        },
    };

    const rzp = new Razorpay(options);

    rzp.on('payment.failed', function (response) {
        console.error('Payment failed:', response.error);
        showCheckoutError('Payment failed: ' + (response.error.description || 'Please try again.'));
        payButton.disabled = false;
        payBtnText.textContent = 'Pay ₹' + _checkoutGrandTotal;
    });

    rzp.open();
}

// ============================================
// UI HELPERS
// ============================================

function showCheckoutError(message) {
    // Remove any existing error
    let existing = document.getElementById('checkoutError');
    if (existing) existing.remove();

    const errorDiv = document.createElement('div');
    errorDiv.id = 'checkoutError';
    errorDiv.style.cssText = 'background: #FEE2E2; color: #991B1B; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 0.9rem; display: flex; align-items: center; gap: 8px;';
    errorDiv.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${message}`;

    const form = document.getElementById('checkoutForm');
    if (form) form.insertBefore(errorDiv, form.firstChild);

    // Auto-remove after 10 seconds
    setTimeout(() => { if (errorDiv.parentNode) errorDiv.remove(); }, 10000);
}

// ============================================
// UTILITIES (from script.js for single item mode)
// ============================================

function getPriceForWeight(product, weightStr) {
    const w = weightStr.toLowerCase().replace('kg', 'Kg');
    if (w === '100g' && product.price100g) return product.price100g;
    if (w === '250g' && product.price250) return product.price250;
    if (w === '500g' && product.price500) return product.price500;
    if ((w === '1kg' || w === '1Kg') && product.price1000) return product.price1000;
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
