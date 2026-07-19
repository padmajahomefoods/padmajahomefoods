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
            delivery_charge, delivery_discount, cart_hash, pending_order_id
        } = body;

        // Validate required fields
        if (!amount || amount <= 0) {
            return jsonResponse(400, { success: false, message: 'Invalid amount' }, corsHeaders);
        }

        const keyId = context.env.RAZORPAY_KEY_ID;
        const keySecret = context.env.RAZORPAY_KEY_SECRET;
        const supabaseUrl = context.env.SUPABASE_URL;
        const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!keyId || !keySecret || !supabaseUrl || !supabaseKey) {
            console.error('Server configuration error');
            return jsonResponse(500, { success: false, message: 'Server configuration error' }, corsHeaders);
        }

        // 1. Lazy Cleanup of Old Pending Orders
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

        // 2. Idempotency Check
        if (pending_order_id && cart_hash) {
            try {
                const orderQuery = await fetch(`${supabaseUrl}/rest/v1/orders?razorpay_order_id=eq.${pending_order_id}&status=eq.pending&select=*`, {
                    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
                });
                const existingOrders = await orderQuery.json();

                if (existingOrders && existingOrders.length > 0) {
                    const existing = existingOrders[0];
                    const orderAgeMs = Date.now() - new Date(existing.created_at).getTime();
                    
                    if (orderAgeMs < 30 * 60 * 1000 && existing.notes && existing.notes.includes(`CartHash:${cart_hash}`)) {
                        console.log("Reusing existing pending order:", existing.order_number);
                        return jsonResponse(200, {
                            success: true,
                            order_id: existing.razorpay_order_id,
                            amount: Math.round(amount * 100),
                            currency: currency || 'INR',
                            key_id: keyId,
                        }, corsHeaders);
                    }
                }
            } catch(e) {
                console.error("Idempotency check failed:", e);
            }
        }

        // 3. Create Razorpay order
        const razorpayResponse = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + btoa(keyId + ':' + keySecret),
            },
            body: JSON.stringify({
                amount: Math.round(amount * 100), // Razorpay expects paise
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

        // 4. Insert Supabase Pending Order
        let addressObj = delivery_address || '';
        if (typeof addressObj === 'string' && addressObj.length > 0) {
            addressObj = { full_address: addressObj };
        }

        const orderNotes = `${customer_name || 'Guest'} | ${customer_email || ''} | ${customer_phone || ''} | Subtotal: ${subtotal || 0} | Delivery: ${delivery_charge || 0} | Discount: ${delivery_discount || 0} | CartHash:${cart_hash}`;

        const orderPayload = {
            order_number: orderNumber,
            user_id: user_id || null,
            total_amount: amount,
            delivery_address: addressObj || null,
            status: 'pending',
            razorpay_order_id: rzpOrder.id,
            notes: orderNotes
        };

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

        // 5. Insert Order Items
        if (items && items.length > 0) {
            const orderItems = items.map(item => {
                const mapped = {
                    order_id: savedOrder.id,
                    product_name: item.name || item.product_name || '',
                    weight: item.weight || '',
                    price: item.price,
                    quantity: item.quantity,
                    total: item.price * item.quantity,
                };
                if (item.product_id && item.product_id !== '') {
                    mapped.product_id = item.product_id;
                }
                return mapped;
            });

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
