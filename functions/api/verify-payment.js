// ============================================
// Cloudflare Pages Function — Verify Razorpay Payment
// Route: POST /api/verify-payment
// Secrets: RAZORPAY_KEY_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (env vars)
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
            razorpay_payment_id,
            razorpay_order_id,
            razorpay_signature,
            items,
            delivery_address,
            customer,
            total_amount,
        } = body;

        // --- 1. Validate required fields ---
        if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
            return jsonResponse(400, { success: false, message: 'Missing payment verification fields' }, corsHeaders);
        }
        if (!items || !items.length) {
            return jsonResponse(400, { success: false, message: 'No items in order' }, corsHeaders);
        }

        const keySecret = context.env.RAZORPAY_KEY_SECRET;
        const supabaseUrl = context.env.SUPABASE_URL;
        const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!keySecret || !supabaseUrl || !supabaseKey) {
            console.error('Missing environment variables for payment verification');
            return jsonResponse(500, { success: false, message: 'Server configuration error' }, corsHeaders);
        }

        // --- 2. Verify Razorpay signature (HMAC-SHA256) ---
        const expectedSignature = await hmacSHA256(
            razorpay_order_id + '|' + razorpay_payment_id,
            keySecret
        );

        if (expectedSignature !== razorpay_signature) {
            console.error('Signature verification failed');
            return jsonResponse(400, { success: false, message: 'Payment verification failed — invalid signature' }, corsHeaders);
        }

        // --- 3. Generate order number ---
        const orderNumber = 'PHF' + Date.now();

        // --- 4. Insert order into Supabase ---
        const orderPayload = {
            order_number: orderNumber,
            user_id: customer?.user_id || null,
            total_amount: total_amount,
            delivery_address: delivery_address || '',
            status: 'confirmed',
            payment_id: razorpay_payment_id,
            razorpay_order_id: razorpay_order_id,
            notes: customer?.name
                ? `${customer.name} | ${customer.email || ''} | ${customer.phone || ''}`
                : '',
        };

        const orderRes = await supabaseInsert(supabaseUrl, supabaseKey, 'orders', orderPayload);

        if (!orderRes.ok) {
            const errText = await orderRes.text();
            console.error('Supabase order insert failed:', errText);
            return jsonResponse(500, { success: false, message: 'Failed to save order' }, corsHeaders);
        }

        const [order] = await orderRes.json();

        // --- 5. Insert order items ---
        const orderItems = items.map(item => ({
            order_id: order.id,
            product_id: item.product_id || '',
            product_name: item.name || item.product_name || '',
            weight: item.weight || '',
            price: item.price,
            quantity: item.quantity,
            total: item.price * item.quantity,
        }));

        const itemsRes = await supabaseInsert(supabaseUrl, supabaseKey, 'order_items', orderItems);

        if (!itemsRes.ok) {
            const errText = await itemsRes.text();
            console.error('Supabase order_items insert failed:', errText);
            // Rollback: delete the order
            await supabaseDelete(supabaseUrl, supabaseKey, 'orders', order.id);
            return jsonResponse(500, { success: false, message: 'Failed to save order items' }, corsHeaders);
        }

        // --- 6. Return success ---
        return jsonResponse(200, {
            success: true,
            order_number: orderNumber,
            order_id: order.id,
        }, corsHeaders);

    } catch (err) {
        console.error('verify-payment error:', err);
        return jsonResponse(500, { success: false, message: 'Internal server error' }, corsHeaders);
    }
}

// Handle CORS preflight
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

// ============================================
// HELPERS
// ============================================

function jsonResponse(status, body, corsHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
}

async function hmacSHA256(message, secret) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function supabaseInsert(url, key, table, data) {
    return fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Prefer': 'return=representation',
        },
        body: JSON.stringify(Array.isArray(data) ? data : [data]),
    });
}

async function supabaseDelete(url, key, table, id) {
    return fetch(`${url}/rest/v1/${table}?id=eq.${id}`, {
        method: 'DELETE',
        headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
        },
    });
}
