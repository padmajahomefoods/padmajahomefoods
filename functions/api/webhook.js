// ============================================
// Route: POST /api/webhook
// Secrets: RAZORPAY_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (env vars)
// ============================================

export async function onRequestPost(context) {
    try {
        // Read raw body for signature verification
        const rawBody = await context.request.text();
        
        // Get signature from headers
        const signature = context.request.headers.get('x-razorpay-signature') || 
                          context.request.headers.get('X-Razorpay-Signature');

        if (!signature) {
            console.error('Missing X-Razorpay-Signature header');
            return new Response('Missing signature', { status: 400 });
        }

        // Use a dedicated secret for Razorpay webhooks
        const webhookSecret = context.env.RAZORPAY_WEBHOOK_SECRET;
        const supabaseUrl = context.env.SUPABASE_URL;
        const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!webhookSecret || !supabaseUrl || !supabaseKey) {
            console.error('Missing environment variables for webhook');
            return new Response('Server configuration error', { status: 500 });
        }

        // --- 1. Verify Razorpay webhook signature (HMAC-SHA256) ---
        const expectedSignature = await hmacSHA256(rawBody, webhookSecret);

        if (expectedSignature !== signature) {
            console.error('Webhook signature verification failed', { expected: expectedSignature, received: signature });
            return new Response('Invalid signature', { status: 400 });
        }

        // --- 2. Parse payload ---
        const event = JSON.parse(rawBody);
        console.log('Received Razorpay Webhook Event:', event.event);

        // Extract order ID from payload (different events have the order ID in different places)
        let razorpayOrderId = null;
        let paymentId = null;

        if (event.payload.payment && event.payload.payment.entity) {
            razorpayOrderId = event.payload.payment.entity.order_id;
            paymentId = event.payload.payment.entity.id;
        } else if (event.payload.order && event.payload.order.entity) {
            razorpayOrderId = event.payload.order.entity.id;
        }

        if (!razorpayOrderId) {
            console.log('No order ID found in webhook payload. Skipping.');
            return new Response('OK', { status: 200 }); // Return 200 so Razorpay doesn't retry
        }

        // --- 3. Handle specific events ---
        let newStatus = null;

        switch (event.event) {
            case 'payment.captured':
            case 'order.paid':
                newStatus = 'confirmed';
                break;
            case 'payment.failed':
                newStatus = 'failed';
                break;
            case 'payment.authorized':
                newStatus = 'processing';
                break;
            default:
                console.log(`Unhandled event type: ${event.event}. Acknowledging.`);
                return new Response('OK', { status: 200 });
        }

        // --- 4. Update Supabase order status ---
        const updatePayload = {
            status: newStatus
        };
        
        if (paymentId) {
            updatePayload.payment_id = paymentId;
        }

        const res = await supabaseUpdate(supabaseUrl, supabaseKey, 'orders', razorpayOrderId, updatePayload);

        if (!res.ok) {
            const errText = await res.text();
            console.error('Supabase order update failed in webhook:', errText);
            // Even if DB fails, return 500 so Razorpay retries
            return new Response('Database update failed', { status: 500 });
        }

        console.log(`Order ${razorpayOrderId} successfully updated to ${newStatus}`);
        return new Response('OK', { status: 200 });

    } catch (err) {
        console.error('Webhook processing error:', err);
        return new Response('Internal server error', { status: 500 });
    }
}

// ============================================
// HELPERS
// ============================================

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

// Update order by razorpay_order_id
async function supabaseUpdate(url, key, table, razorpayOrderId, data) {
    return fetch(`${url}/rest/v1/${table}?razorpay_order_id=eq.${razorpayOrderId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Prefer': 'return=representation', // Optional, useful if you want to log the updated row
        },
        body: JSON.stringify(data),
    });
}
