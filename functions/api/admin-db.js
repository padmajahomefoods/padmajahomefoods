export async function onRequestPost(context) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    try {
        // 1. Verify Authorization Header
        const authHeader = context.request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), { status: 401, headers: corsHeaders });
        }
        const token = authHeader.split(' ')[1];

        const supabaseUrl = context.env.SUPABASE_URL;
        const supabaseKey = context.env.SUPABASE_SERVICE_ROLE_KEY;
        const anonKey = context.request.headers.get('x-anon-key');

        if (!supabaseUrl || !supabaseKey) {
            return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500, headers: corsHeaders });
        }

        if (!anonKey) {
            return new Response(JSON.stringify({ error: 'Missing Anon Key from frontend headers' }), { status: 500, headers: corsHeaders });
        }

        // 2. Validate user using Supabase Auth
        const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
            headers: {
                'apikey': anonKey,
                'Authorization': `Bearer ${token}`
            }
        });

        if (!authRes.ok) {
            const authErrText = await authRes.text();
            console.error("[admin-db] Auth verification failed:", authRes.status, authErrText);
            return new Response(JSON.stringify({ error: 'Auth verification failed', details: authErrText, status: authRes.status }), { status: authRes.status, headers: corsHeaders });
        }

        const user = await authRes.json();
        console.log("[admin-db] Auth successful. User email:", user.email);
        
        // 3. Admin Role Check
        const isLegacyAdmin = user.email && user.email.endsWith('@padmajahomefoods.internal');
        const isRoleAdmin = user.user_metadata && user.user_metadata.role === 'admin';
        console.log("[admin-db] Admin check: legacy=", isLegacyAdmin, "role=", isRoleAdmin);
        
        if (!isLegacyAdmin && !isRoleAdmin) {
            console.error("[admin-db] User is not an admin.");
            return new Response(JSON.stringify({ error: 'Forbidden. Admin privileges required.' }), { status: 403, headers: corsHeaders });
        }

        // 4. Parse request payload
        const bodyText = await context.request.text();
        console.log("[admin-db] Received payload:", bodyText);
        let body;
        try {
            body = JSON.parse(bodyText);
        } catch (e) {
            console.error("[admin-db] Failed to parse JSON body", e.message);
            return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: corsHeaders });
        }
        
        const { table, action, match, inFilter, order, payload, selectColumns = '*' } = body;

        if (!table || !action) {
            console.error("[admin-db] Missing table or action");
            return new Response(JSON.stringify({ error: 'Table and action are required' }), { status: 400, headers: corsHeaders });
        }
        
        // 5. Execute DB operation with Service Role Key
        let endpoint = `${supabaseUrl}/rest/v1/${table}`;
        let method = 'GET';
        let fetchHeaders = {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
        };
        let fetchBody = undefined;
        let queryParams = new URLSearchParams();

        if (action === 'select') {
            method = 'GET';
            queryParams.append('select', selectColumns);
            
            if (match) {
                for (const [k, v] of Object.entries(match)) {
                    queryParams.append(k, `eq.${v}`);
                }
            }
            if (inFilter && inFilter.column && inFilter.values) {
                queryParams.append(inFilter.column, `in.(${inFilter.values.join(',')})`);
            }
            if (order && order.column) {
                const dir = order.ascending === false ? 'desc' : 'asc';
                queryParams.append('order', `${order.column}.${dir}`);
            }
        } 
        else if (action === 'update') {
            method = 'PATCH';
            fetchHeaders['Prefer'] = 'return=representation';
            fetchBody = JSON.stringify(payload);
            if (match) {
                for (const [k, v] of Object.entries(match)) {
                    queryParams.append(k, `eq.${v}`);
                }
            } else {
                return new Response(JSON.stringify({ error: 'Update requires a match condition' }), { status: 400, headers: corsHeaders });
            }
        }
        else if (action === 'insert') {
            method = 'POST';
            fetchHeaders['Prefer'] = 'return=representation';
            fetchBody = JSON.stringify(Array.isArray(payload) ? payload : [payload]);
        }
        else if (action === 'delete') {
            method = 'DELETE';
            if (match) {
                for (const [k, v] of Object.entries(match)) {
                    queryParams.append(k, `eq.${v}`);
                }
            } else {
                return new Response(JSON.stringify({ error: 'Delete requires a match condition' }), { status: 400, headers: corsHeaders });
            }
        }
        else {
            return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: corsHeaders });
        }

        const queryString = queryParams.toString();
        if (queryString) {
            endpoint += '?' + queryString;
        }

        console.log(`[admin-db] Executing Supabase DB request: ${method} ${endpoint}`);

        const dbRes = await fetch(endpoint, {
            method: method,
            headers: fetchHeaders,
            body: fetchBody
        });

        if (!dbRes.ok) {
            const errText = await dbRes.text();
            console.error(`[admin-db] Supabase DB Error (${dbRes.status}):`, errText);
            return new Response(JSON.stringify({ error: 'Database operation failed', details: errText }), { status: dbRes.status, headers: corsHeaders });
        }

        const responseText = await dbRes.text();
        let data = null;
        if (responseText) {
            try {
                data = JSON.parse(responseText);
            } catch (e) {
                console.error("[admin-db] Failed to parse Supabase JSON response:", e.message);
            }
        }

        console.log(`[admin-db] Success! Returning data length: ${Array.isArray(data) ? data.length : 'object'}`);
        
        if (context.waitUntil) {
            context.waitUntil(recoverPendingOrders(context.env));
        }
        
        return new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (err) {
        console.error("[admin-db] UNCAUGHT EXCEPTION:", err.message);
        console.error(err.stack);
        return new Response(JSON.stringify({ 
            error: 'Internal Server Error', 
            details: err.message,
            stack: err.stack 
        }), { 
            status: 500, 
            headers: corsHeaders 
        });
    }
}

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
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
        
        const query = `${supabaseUrl}/rest/v1/orders?status=eq.pending&created_at=gte.${thirtyMinsAgo}&created_at=lte.${fiveMinsAgo}&select=id,razorpay_order_id,order_number`;
        const res = await fetch(query, {
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        
        if (!res.ok) return;
        
        const pendingOrders = await res.json();
        
        for (const order of pendingOrders) {
            if (!order.razorpay_order_id) continue;
            
            const rzpRes = await fetch(`https://api.razorpay.com/v1/orders/${order.razorpay_order_id}/payments`, {
                headers: { 'Authorization': `Basic ${btoa(keyId + ':' + keySecret)}` }
            });
            
            if (!rzpRes.ok) continue;
            
            const rzpData = await rzpRes.json();
            if (rzpData && rzpData.items && rzpData.items.length > 0) {
                // Determine actual payment state
                const capturedPayment = rzpData.items.find(p => p.status === 'captured');
                const failedPayment = rzpData.items.find(p => p.status === 'failed');
                
                let newStatus = null;
                let paymentId = null;
                
                if (capturedPayment) {
                    newStatus = 'confirmed';
                    paymentId = capturedPayment.id;
                } else if (failedPayment) {
                    newStatus = 'payment_failed';
                    paymentId = failedPayment.id;
                }
                
                if (newStatus) {
                    const updatePayload = { status: newStatus };
                    if (paymentId) updatePayload.payment_id = paymentId;
                    
                    await fetch(`${supabaseUrl}/rest/v1/orders?id=eq.${order.id}`, {
                        method: 'PATCH',
                        headers: {
                            'Content-Type': 'application/json',
                            'apikey': supabaseKey,
                            'Authorization': `Bearer ${supabaseKey}`
                        },
                        body: JSON.stringify(updatePayload)
                    });
                    console.log(`[Recovery] Automatically recovered pending order ${order.order_number} to ${newStatus}`);
                }
            }
        }
    } catch (e) {
        console.error('[Recovery] Error during background recovery:', e);
    }
}
