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
        const anonKey = context.env.SUPABASE_ANON_KEY;

        if (!supabaseUrl || !supabaseKey) {
            return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500, headers: corsHeaders });
        }

        // 2. Validate user using Supabase Auth
        const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${token}`
            }
        });

        if (!authRes.ok) {
            const authErrText = await authRes.text();
            console.error("[admin-db] Auth verification failed:", authRes.status, authErrText);
            return new Response(JSON.stringify({ error: 'Invalid or expired token', details: authErrText }), { status: 401, headers: corsHeaders });
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
            headers: { 'Content-Type': 'application/json', ...corsHeaders } 
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
