// ============================================
// Cloudflare Pages Function — Create Razorpay Order & Pending DB Order
// Route: POST /api/create-order
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (env vars)
// ============================================

export async function onRequestPost(context) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
        const body = await context.request.json();
        const { 
            amount, currency, receipt, customer_name, customer_email, customer_phone,
            user_id, items, delivery_address, subtotal, total_weight, 
            delivery_charge, delivery_discount, cart_hash, pending_order_id,
            coupon_code, coupon_discount
        } = body;

        // Validate required fields
        if (!amount || Number(amount) <= 0) {
            return jsonResponse(400, { success: false, message: 'Invalid order amount' }, corsHeaders);
        }

        if (!items || !Array.isArray(items) || items.length === 0) {
            return jsonResponse(400, { success: false, message: 'Cart items are required' }, corsHeaders);
        }

        const keyId = context.env ? context.env.RAZORPAY_KEY_ID : undefined;
        const keySecret = context.env ? context.env.RAZORPAY_KEY_SECRET : undefined;
        const supabaseUrl = context.env ? context.env.SUPABASE_URL : undefined;
        const supabaseKey = context.env ? context.env.SUPABASE_SERVICE_ROLE_KEY : undefined;

        // Temporary Safe Diagnostics
        const diagnostics = {
            endpoint: 'create-order',
            has_env: Boolean(context.env),
            has_SUPABASE_URL: Boolean(supabaseUrl),
            has_SUPABASE_SERVICE_ROLE_KEY: Boolean(supabaseKey),
            has_RAZORPAY_KEY_ID: Boolean(keyId),
            has_RAZORPAY_KEY_SECRET: Boolean(keySecret),
            has_SUPABASE_KEY: Boolean(context.env && context.env.SUPABASE_KEY),
            has_SUPABASE_SERVICE_KEY: Boolean(context.env && context.env.SUPABASE_SERVICE_KEY),
            has_RAZORPAY_KEY: Boolean(context.env && context.env.RAZORPAY_KEY),
            has_RAZORPAY_SECRET: Boolean(context.env && context.env.RAZORPAY_SECRET),
        };
        console.log('[Diagnostics:create-order]', JSON.stringify(diagnostics));

        if (!keyId || !keySecret || !supabaseUrl || !supabaseKey) {
            console.error('Server configuration error: missing required environment variables', diagnostics);
            return jsonResponse(500, { success: false, message: 'Server configuration error', diagnostics }, corsHeaders);
        }

        // ============================================
        // 0. SERVER-SIDE AUTHORITATIVE CATALOG & PRICE VERIFICATION
        // ============================================
        const prodsRes = await fetch(`${supabaseUrl}/rest/v1/products?select=id,name,available,weights,price_100g,price_250,price_500,price_1000`, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        if (!prodsRes.ok) {
            console.error('Failed to fetch products for price verification:', await prodsRes.text());
            return jsonResponse(500, { success: false, message: 'Product catalog unavailable' }, corsHeaders);
        }
        const dbProducts = await prodsRes.json();
        const productsById = new Map();
        const productsByName = new Map();
        for (const p of dbProducts) {
            productsById.set(p.id, p);
            if (p.name) productsByName.set(p.name.trim().toLowerCase(), p);
        }

        let serverSubtotal = 0;
        let serverTotalWeight = 0;
        const verifiedItems = [];

        for (const item of items) {
            const rawQty = Number(item.quantity);
            if (!Number.isInteger(rawQty) || rawQty < 1 || rawQty > 50) {
                return jsonResponse(400, { success: false, message: 'Invalid item quantity' }, corsHeaders);
            }

            let product = null;
            if (item.product_id && productsById.has(item.product_id)) {
                product = productsById.get(item.product_id);
            } else if (item.name && productsByName.has(item.name.trim().toLowerCase())) {
                product = productsByName.get(item.name.trim().toLowerCase());
            } else if (item.name && productsById.has(slugifyName(item.name))) {
                product = productsById.get(slugifyName(item.name));
            }

            if (!product) {
                console.error(`Product not found in database: ${item.name || item.product_id}`);
                return jsonResponse(400, { success: false, message: `Product not found: ${item.name || item.product_id}` }, corsHeaders);
            }

            if (product.available === false) {
                return jsonResponse(400, { success: false, message: `"${product.name}" is currently out of stock` }, corsHeaders);
            }

            const expectedUnitPrice = calculateItemUnitPrice(product, item.weight);
            if (!expectedUnitPrice || expectedUnitPrice <= 0) {
                return jsonResponse(400, { success: false, message: `Invalid pricing for item "${product.name}"` }, corsHeaders);
            }

            const grams = parseWeightInGrams(item.weight);
            const lineTotal = expectedUnitPrice * rawQty;

            serverSubtotal += lineTotal;
            serverTotalWeight += (grams * rawQty);

            verifiedItems.push({
                product_id: product.id,
                product_name: product.name,
                weight: item.weight || '',
                price: expectedUnitPrice,
                quantity: rawQty,
                total: lineTotal
            });
        }

        // ============================================
        // 1. SERVER-SIDE DELIVERY CHARGES CALCULATION
        // ============================================
        let deliveryThreshold = 1999;
        let deliverySlabs = [
            { maxWeight: 500, charge: 59 },
            { maxWeight: 1000, charge: 89 },
            { maxWeight: 2000, charge: 129 },
            { maxWeight: 3000, charge: 169 }
        ];
        let maxSlabCharge = 249;

        try {
            const settingsRes = await fetch(`${supabaseUrl}/rest/v1/settings?key=eq.delivery&select=*`, {
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            });
            if (settingsRes.ok) {
                const settingsData = await settingsRes.json();
                if (settingsData && settingsData.length > 0) {
                    const val = typeof settingsData[0].value === 'string'
                        ? JSON.parse(settingsData[0].value)
                        : settingsData[0].value;
                    if (val) {
                        if (val.free_delivery_threshold !== undefined) deliveryThreshold = Number(val.free_delivery_threshold);
                        if (Array.isArray(val.weight_slabs)) deliverySlabs = val.weight_slabs;
                        if (val.max_slab_charge !== undefined) maxSlabCharge = Number(val.max_slab_charge);
                    }
                }
            }
        } catch (e) {
            console.warn('Could not load delivery settings from DB, using defaults', e);
        }

        let calculatedDeliveryCharge = maxSlabCharge;
        for (const slab of deliverySlabs) {
            if (serverTotalWeight <= slab.maxWeight) {
                calculatedDeliveryCharge = slab.charge;
                break;
            }
        }

        let serverDeliveryCharge = calculatedDeliveryCharge;
        let serverDeliveryDiscount = 0;
        if (serverSubtotal >= deliveryThreshold) {
            serverDeliveryDiscount = calculatedDeliveryCharge;
            serverDeliveryCharge = 0;
        }

        // ============================================
        // 2. SERVER-SIDE COUPON VALIDATION
        // ============================================
        let finalCouponDiscount = 0;
        if (coupon_code) {
            try {
                const couponRes = await fetch(`${supabaseUrl}/rest/v1/coupons?code=eq.${encodeURIComponent(coupon_code.toUpperCase())}&select=*`, {
                    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
                });
                const coupons = await couponRes.json();
                
                if (!coupons || coupons.length === 0) return jsonResponse(400, { success: false, message: 'Invalid coupon code' }, corsHeaders);
                const coupon = coupons[0];

                if (!coupon.is_active) return jsonResponse(400, { success: false, message: 'Coupon is not active' }, corsHeaders);
                const now = new Date();
                if (coupon.start_date && new Date(coupon.start_date) > now) return jsonResponse(400, { success: false, message: 'Coupon is not yet valid' }, corsHeaders);
                if (coupon.expiry_date && new Date(coupon.expiry_date) < now) return jsonResponse(400, { success: false, message: 'Coupon has expired' }, corsHeaders);
                
                if (coupon.minimum_order_value && serverSubtotal < coupon.minimum_order_value) {
                    return jsonResponse(400, { success: false, message: `Minimum order requirement of ₹${coupon.minimum_order_value} not met` }, corsHeaders);
                }
                if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) return jsonResponse(400, { success: false, message: 'Coupon usage limit reached' }, corsHeaders);
                if (!user_id) return jsonResponse(401, { success: false, message: 'Please login to use a coupon' }, corsHeaders);

                if (coupon.customer_eligibility === 'first_order' || coupon.customer_eligibility === 'existing') {
                    const ordRes = await fetch(`${supabaseUrl}/rest/v1/orders?user_id=eq.${user_id}&status=in.(confirmed,shipped,delivered)&select=id&limit=1`, {
                        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
                    });
                    const ords = await ordRes.json();
                    const hasOrders = ords && ords.length > 0;
                    if (coupon.customer_eligibility === 'first_order' && hasOrders) return jsonResponse(400, { success: false, message: 'Valid for first-time orders only' }, corsHeaders);
                    if (coupon.customer_eligibility === 'existing' && !hasOrders) return jsonResponse(400, { success: false, message: 'For existing customers only' }, corsHeaders);
                }

                if (coupon.usage_per_customer === 'once') {
                    const usageRes = await fetch(`${supabaseUrl}/rest/v1/coupon_usages?coupon_id=eq.${coupon.id}&user_id=eq.${user_id}&select=id&limit=1`, {
                        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
                    });
                    const usages = await usageRes.json();
                    if (usages && usages.length > 0) return jsonResponse(400, { success: false, message: 'This coupon has already been used on your account' }, corsHeaders);
                }

                let calcDiscount = 0;
                if (coupon.discount_type === 'percentage') {
                    calcDiscount = (serverSubtotal * coupon.discount_value) / 100;
                    if (coupon.maximum_discount !== null && calcDiscount > coupon.maximum_discount) calcDiscount = coupon.maximum_discount;
                } else if (coupon.discount_type === 'fixed') {
                    calcDiscount = coupon.discount_value;
                }
                if (calcDiscount > serverSubtotal) calcDiscount = serverSubtotal;
                finalCouponDiscount = Math.round(calcDiscount);

            } catch (err) {
                console.error("Coupon validation error in create-order:", err);
                return jsonResponse(500, { success: false, message: 'Failed to validate coupon during order creation' }, corsHeaders);
            }
        }

        // ============================================
        // 3. AUTHORITATIVE FINAL AMOUNT & ANTI-TAMPERING CHECK
        // ============================================
        const serverGrandTotal = Math.max(0, serverSubtotal + serverDeliveryCharge - finalCouponDiscount);

        // Security check: reject manipulated prices or inconsistent client totals
        // Allow up to ₹2 tolerance for client vs server rounding edge cases
        if (Math.abs(serverGrandTotal - Number(amount)) > 2) {
            console.error(`Price tampering / total mismatch detected: client requested ${amount}, server computed ${serverGrandTotal}`);
            return jsonResponse(400, { success: false, message: 'Order total mismatch. Please refresh checkout and try again.' }, corsHeaders);
        }

        const finalAmount = serverGrandTotal;

        // 4. Lazy Cleanup of Old Pending Orders
        try {
            const cleanupDate = new Date(Date.now() - 30 * 60 * 1000).toISOString();
            await fetch(`${supabaseUrl}/rest/v1/orders?status=eq.pending&created_at=lt.${cleanupDate}`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': supabaseKey,
                    'Authorization': `Bearer ${supabaseKey}`
                },
                body: JSON.stringify({ status: 'cancelled' })
            });
        } catch(e) {
            console.error('Lazy cleanup failed', e);
        }

        // 5. Idempotency Check with Total Amount Verification
        if (pending_order_id && cart_hash) {
            try {
                const orderQuery = await fetch(`${supabaseUrl}/rest/v1/orders?razorpay_order_id=eq.${pending_order_id}&status=eq.pending&select=*`, {
                    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
                });
                const existingOrders = await orderQuery.json();

                if (existingOrders && existingOrders.length > 0) {
                    const existing = existingOrders[0];
                    const orderAgeMs = Date.now() - new Date(existing.created_at).getTime();
                    
                    if (orderAgeMs < 30 * 60 * 1000 &&
                        existing.notes &&
                        existing.notes.includes(`CartHash:${cart_hash}`) &&
                        Number(existing.total_amount) === finalAmount) {
                        console.log("Reusing existing pending order:", existing.order_number);
                        return jsonResponse(200, {
                            success: true,
                            order_id: existing.razorpay_order_id,
                            amount: Math.round(finalAmount * 100),
                            currency: currency || 'INR',
                            key_id: keyId,
                        }, corsHeaders);
                    }
                }
            } catch(e) {
                console.error("Idempotency check failed:", e);
            }
        }

        // 6. Create Razorpay order (paise unit required by Razorpay)
        const razorpayResponse = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + btoa(keyId + ':' + keySecret),
            },
            body: JSON.stringify({
                amount: Math.round(finalAmount * 100), // Razorpay expects paise
                currency: currency || 'INR',
                receipt: receipt || 'rcpt_' + Date.now(),
                notes: {
                    customer_name: customer_name || '',
                    customer_phone: customer_phone || '',
                },
            }),
        });

        if (!razorpayResponse.ok) {
            const errorBody = await razorpayResponse.text();
            console.error('Razorpay order creation failed:', razorpayResponse.status, errorBody);
            return jsonResponse(502, { success: false, message: 'Failed to create payment order' }, corsHeaders);
        }

        const rzpOrder = await razorpayResponse.json();
        const orderNumber = 'PHF' + Date.now();

        // 7. Insert Supabase Pending Order (Rupees unit stored in database)
        let addressObj = delivery_address || '';
        if (typeof addressObj === 'string' && addressObj.length > 0) {
            addressObj = { full_address: addressObj };
        }

        const orderNotes = `${customer_name || 'Guest'} | ${customer_email || ''} | ${customer_phone || ''} | Subtotal: ${serverSubtotal} | Delivery: ${serverDeliveryCharge} | Discount: ${serverDeliveryDiscount} | Coupon: ${coupon_code || 'None'} | CartHash:${cart_hash}`;

        const orderPayload = {
            order_number: orderNumber,
            total_amount: finalAmount,
            delivery_address: addressObj || null,
            status: 'pending',
            razorpay_order_id: rzpOrder.id,
            notes: orderNotes
        };
        
        if (coupon_code) {
            orderPayload.coupon_code = coupon_code.toUpperCase();
            orderPayload.coupon_discount = finalCouponDiscount;
        }
        
        if (user_id) {
            orderPayload.user_id = user_id;
        }

        const orderRes = await fetch(`${supabaseUrl}/rest/v1/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(orderPayload)
        });

        if (!orderRes.ok) {
            console.error('Supabase insert failed:', await orderRes.text());
            return jsonResponse(500, { success: false, message: 'Failed to save order' }, corsHeaders);
        }

        const [savedOrder] = await orderRes.json();

        // 8. Insert Order Items with Verified Authoritative Prices & Totals
        const orderItems = verifiedItems.map(item => ({
            order_id: savedOrder.id,
            product_id: item.product_id,
            product_name: item.product_name,
            weight: item.weight,
            price: item.price,
            quantity: item.quantity,
            total: item.total,
        }));

        const itemsRes = await fetch(`${supabaseUrl}/rest/v1/order_items`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            },
            body: JSON.stringify(orderItems)
        });

        if (!itemsRes.ok) {
            const errText = await itemsRes.text();
            console.error('Supabase items insert failed:', errText);
            // Rollback order
            await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${savedOrder.id}`, {
                method: 'DELETE',
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            });
            return jsonResponse(500, { success: false, message: 'Failed to save items', detail: errText }, corsHeaders);
        }

        if (context.waitUntil) {
            context.waitUntil(recoverPendingOrders(context.env));
        }

        return jsonResponse(200, {
            success: true,
            order_id: rzpOrder.id, // razorpay_order_id for frontend
            amount: rzpOrder.amount,
            currency: rzpOrder.currency,
            key_id: keyId,
        }, corsHeaders);

    } catch (err) {
        console.error('create-order error:', err);
        return jsonResponse(500, { success: false, message: 'Internal server error' }, corsHeaders);
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}

function jsonResponse(status, body, corsHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

async function recoverPendingOrders(env) {
    try {
        const keyId = env.RAZORPAY_KEY_ID;
        const keySecret = env.RAZORPAY_KEY_SECRET;
        const supabaseUrl = env.SUPABASE_URL;
        const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (!keyId || !keySecret || !supabaseUrl || !supabaseKey) return;
        
        // Only recover orders that have been pending for at least 5 minutes, 
        // to avoid interfering with orders currently being checked out
        const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        
        console.log(`[Recovery] Triggered. Fetching orders between ${thirtyMinsAgo} and ${fiveMinsAgo}`);
        
        const query = `${supabaseUrl}/rest/v1/orders?status=in.(pending,processing)&created_at=gte.${thirtyMinsAgo}&created_at=lte.${fiveMinsAgo}&select=id,razorpay_order_id,order_number,status`;
        const res = await fetch(query, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        
        if (!res.ok) {
            console.error('[Recovery] Supabase query failed:', await res.text());
            return;
        }
        
        const pendingOrders = await res.json();
        console.log(`[Recovery] Found ${pendingOrders.length} stuck order(s).`, pendingOrders.map(o => o.order_number));
        
        for (const order of pendingOrders) {
            if (!order.razorpay_order_id) {
                console.log(`[Recovery] Skipping ${order.order_number} - no razorpay_order_id`);
                continue;
            }
            
            console.log(`[Recovery] Querying Razorpay for ${order.order_number} (rzp_order_id: ${order.razorpay_order_id})`);
            const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${order.razorpay_order_id}/payments`, {
                headers: { 'Authorization': `Basic ${btoa(keyId + ':' + keySecret)}` }
            });
            
            if (!rzpRes.ok) {
                console.error(`[Recovery] Razorpay API failed for ${order.order_number}:`, await rzpRes.text());
                continue;
            }
            
            const rzpData = await rzpRes.json();
            console.log(`[Recovery] Razorpay response for ${order.order_number}:`, JSON.stringify(rzpData));
            
            if (rzpData && rzpData.items && rzpData.items.length > 0) {
                // Determine actual payment state
                const capturedPayment = rzpData.items.find(p => p.status === 'captured');
                const failedPayment = rzpData.items.find(p => p.status === 'failed');
                
                let newStatus = null;
                let paymentId = null;
                
                if (capturedPayment) {
                    newStatus = 'confirmed';
                    paymentId = capturedPayment.id;
                    console.log(`[Recovery] Found captured payment for ${order.order_number}`);
                } else if (failedPayment) {
                    newStatus = 'payment_failed';
                    paymentId = failedPayment.id;
                    console.log(`[Recovery] Found failed payment for ${order.order_number}`);
                } else {
                    console.log(`[Recovery] No captured or failed payments found for ${order.order_number}`);
                }
                
                if (newStatus && newStatus !== order.status) {
                    console.log(`[Recovery] Updating ${order.order_number} to ${newStatus}`);
                    const updatePayload = { status: newStatus };
                    if (paymentId) updatePayload.payment_id = paymentId;
                    
                    const updateRes = await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${order.id}`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`
                        },
                        body: JSON.stringify(updatePayload)
                    });
                    
                    if (!updateRes.ok) {
                        console.error(`[Recovery] Update failed for ${order.order_number}:`, await updateRes.text());
                    } else {
                        console.log(`[Recovery] Successfully recovered ${order.order_number} to ${newStatus}`);
                    }
                }
            } else {
                console.log(`[Recovery] No payments found in Razorpay for ${order.order_number}`);
            }
        }
    } catch (e) {
        console.error('[Recovery] Error during background recovery:', e);
    }
}

// ============================================
// AUTHORITATIVE CATALOG & PRICING HELPERS
// ============================================

function parseWeightInGrams(wStr) {
    if (!wStr) return 1000;
    const s = String(wStr).toLowerCase().replace(/\s+/g, '');
    if (s.includes('kg')) {
        return (parseFloat(s) || 1) * 1000;
    }
    return parseFloat(s) || 1000;
}

function calculateItemUnitPrice(product, weightStr) {
    const w = String(weightStr || '').toLowerCase().replace('kg', 'Kg');
    if (w === '100g' && product.price_100g) return Number(product.price_100g);
    if (w === '250g' && product.price_250) return Number(product.price_250);
    if (w === '500g' && product.price_500) return Number(product.price_500);
    if ((w === '1kg' || w === '1Kg') && product.price_1000) return Number(product.price_1000);
    const wGrams = parseWeightInGrams(weightStr);
    const base = Number(product.price_1000 || 0);
    return Math.round((base * wGrams) / 1000);
}

function slugifyName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}
