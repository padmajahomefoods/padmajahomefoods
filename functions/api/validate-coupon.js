export async function onRequestPost(context) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    try {
        const body = await context.request.json();
        const { coupon_code, cart_subtotal, user_id, cart_items } = body;

        if (!coupon_code) {
            return jsonResponse(400, { success: false, message: 'Coupon code is required' }, corsHeaders);
        }

        const supabaseUrl = context.env.SUPABASE_URL;
        const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return jsonResponse(500, { success: false, message: 'Server configuration error' }, corsHeaders);
        }

        // 1. Fetch Coupon
        const couponRes = await fetch(`${supabaseUrl}/rest/v1/coupons?code=eq.${encodeURIComponent(coupon_code.toUpperCase())}&select=*`, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });

        if (!couponRes.ok) {
            return jsonResponse(500, { success: false, message: 'Failed to query coupon' }, corsHeaders);
        }

        const coupons = await couponRes.json();
        if (!coupons || coupons.length === 0) {
            return jsonResponse(404, { success: false, message: 'Invalid coupon code' }, corsHeaders);
        }

        const coupon = coupons[0];

        // 2. Validate Active / Expiry
        if (!coupon.is_active) {
            return jsonResponse(400, { success: false, message: 'This coupon is no longer active' }, corsHeaders);
        }

        const now = new Date();
        if (coupon.start_date && new Date(coupon.start_date) > now) {
            return jsonResponse(400, { success: false, message: 'This coupon is not yet valid' }, corsHeaders);
        }
        if (coupon.expiry_date && new Date(coupon.expiry_date) < now) {
            return jsonResponse(400, { success: false, message: 'This coupon has expired' }, corsHeaders);
        }

        // 3. Validate Minimum Order
        const subtotal = Number(cart_subtotal || 0);
        if (coupon.minimum_order_value && subtotal < coupon.minimum_order_value) {
            return jsonResponse(400, { success: false, message: `Minimum order of ₹${coupon.minimum_order_value} required for this coupon` }, corsHeaders);
        }

        // 4. Validate Total Usage Limit
        if (coupon.usage_limit !== null && coupon.used_count >= coupon.usage_limit) {
            return jsonResponse(400, { success: false, message: 'This coupon has reached its maximum usage limit' }, corsHeaders);
        }

        // 5. Check user_id requirement (Guests cannot use coupons)
        if (!user_id) {
            return jsonResponse(401, { success: false, message: 'Please login or sign up to apply a coupon.' }, corsHeaders);
        }

        // 6. Validate Customer Eligibility
        if (coupon.customer_eligibility === 'first_order' || coupon.customer_eligibility === 'existing') {
            const ordersRes = await fetch(`${supabaseUrl}/rest/v1/orders?user_id=eq.${user_id}&status=in.(confirmed,shipped,delivered)&select=id&limit=1`, {
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            });
            const orders = await ordersRes.json();
            const hasCompletedOrders = orders && orders.length > 0;

            if (coupon.customer_eligibility === 'first_order' && hasCompletedOrders) {
                return jsonResponse(400, { success: false, message: 'This coupon is valid for first-time orders only' }, corsHeaders);
            }
            if (coupon.customer_eligibility === 'existing' && !hasCompletedOrders) {
                return jsonResponse(400, { success: false, message: 'This coupon is for existing customers only' }, corsHeaders);
            }
        }

        // 7. Validate Usage Per Customer ('once')
        if (coupon.usage_per_customer === 'once') {
            const usageRes = await fetch(`${supabaseUrl}/rest/v1/coupon_usages?coupon_id=eq.${coupon.id}&user_id=eq.${user_id}&select=id&limit=1`, {
                headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
            });
            const usages = await usageRes.json();
            if (usages && usages.length > 0) {
                return jsonResponse(400, { success: false, message: 'This coupon has already been used on your account.' }, corsHeaders);
            }
        }

        // 8. Calculate Discount
        let eligibleAmount = subtotal; // If applicable_products is specific, we would calculate this based on cart_items

        let discountAmount = 0;
        if (coupon.discount_type === 'percentage') {
            discountAmount = (eligibleAmount * coupon.discount_value) / 100;
            if (coupon.maximum_discount !== null && discountAmount > coupon.maximum_discount) {
                discountAmount = coupon.maximum_discount;
            }
        } else if (coupon.discount_type === 'fixed') {
            discountAmount = coupon.discount_value;
        }

        // Ensure discount doesn't exceed subtotal
        if (discountAmount > subtotal) {
            discountAmount = subtotal;
        }

        // Return validated result
        return jsonResponse(200, {
            success: true,
            coupon_code: coupon.code,
            discount_amount: Math.round(discountAmount),
            message: 'Coupon applied successfully'
        }, corsHeaders);

    } catch (err) {
        console.error('validate-coupon error:', err);
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
