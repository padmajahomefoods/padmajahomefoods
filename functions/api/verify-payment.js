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
            razorpay_signature
        } = body;

        // 1. Validate required fields
        if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
            return jsonResponse(400, { success: false, message: 'Missing payment verification fields' }, corsHeaders);
        }

        const keySecret = context.env.RAZORPAY_KEY_SECRET;
        const supabaseUrl = context.env.SUPABASE_URL;
        const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!keySecret || !supabaseUrl || !supabaseKey) {
            console.error('Missing environment variables for payment verification');
            return jsonResponse(500, { success: false, message: 'Server configuration error' }, corsHeaders);
        }

        // 2. Verify Razorpay signature (HMAC-SHA256)
        const expectedSignature = await hmacSHA256(
            razorpay_order_id + '|' + razorpay_payment_id,
            keySecret
        );

        if (expectedSignature !== razorpay_signature) {
            console.error('Signature verification failed');
            return jsonResponse(400, { success: false, message: 'Payment verification failed — invalid signature' }, corsHeaders);
        }

        // 3. Update existing order to confirmed
        const updatePayload = {
            status: 'confirmed',
            payment_id: razorpay_payment_id,
            updated_at: new Date().toISOString()
        };

        const updateRes = await fetch(`${supabaseUrl}/rest/v1/orders?razorpay_order_id=eq.${razorpay_order_id}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Prefer': 'return=representation'
            },
            body: JSON.stringify(updatePayload)
        });

        if (!updateRes.ok) {
            const errText = await updateRes.text();
            console.error('Supabase order update failed:', updateRes.status, errText);
            return jsonResponse(500, { success: false, message: 'Failed to update order status' }, corsHeaders);
        }

        const updatedOrders = await updateRes.json();
        
        if (!updatedOrders || updatedOrders.length === 0) {
            console.error('Order not found for razorpay_order_id:', razorpay_order_id);
            return jsonResponse(404, { success: false, message: 'Order not found for this payment' }, corsHeaders);
        }

        const confirmedOrder = updatedOrders[0];

        // 4. Return success
        return jsonResponse(200, {
            success: true,
            order_number: confirmedOrder.order_number,
            order_id: confirmedOrder.id,
        }, corsHeaders);

    } catch (err) {
        console.error('verify-payment error:', err.message, err.stack);
        return jsonResponse(500, { 
            success: false, 
            message: 'Internal server error'
        }, corsHeaders);
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
