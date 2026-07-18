// ============================================
// Cloudflare Pages Function — Create Razorpay Order
// Route: POST /api/create-order
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (env vars)
// ============================================

export async function onRequestPost(context) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
        const { amount, currency, receipt, customer_name, customer_email, customer_phone } = await context.request.json();

        // Validate required fields
        if (!amount || amount <= 0) {
            return new Response(JSON.stringify({ success: false, message: 'Invalid amount' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        const keyId = context.env.RAZORPAY_KEY_ID;
        const keySecret = context.env.RAZORPAY_KEY_SECRET;

        if (!keyId || !keySecret) {
            console.error('Razorpay credentials not configured');
            return new Response(JSON.stringify({ success: false, message: 'Payment gateway not configured' }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        // Create Razorpay order via their REST API
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
                    customer_email: customer_email || '',
                    customer_phone: customer_phone || '',
                },
            }),
        });

        if (!razorpayResponse.ok) {
            const errorBody = await razorpayResponse.text();
            console.error('Razorpay order creation failed:', razorpayResponse.status, errorBody);
            return new Response(JSON.stringify({ success: false, message: 'Failed to create payment order' }), {
                status: 502,
                headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
        }

        const order = await razorpayResponse.json();

        return new Response(JSON.stringify({
            success: true,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            key_id: keyId, // Public key — safe to send to frontend
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

    } catch (err) {
        console.error('create-order error:', err);
        return new Response(JSON.stringify({ success: false, message: 'Internal server error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
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
