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

        const missingEnvVars = [];
        if (!supabaseUrl) missingEnvVars.push("SUPABASE_URL");
        if (!supabaseKey) missingEnvVars.push("SUPABASE_SERVICE_ROLE_KEY");
        if (!anonKey) missingEnvVars.push("SUPABASE_ANON_KEY");

        if (missingEnvVars.length > 0) {
            console.error("[admin-db] Missing environment variables:", missingEnvVars.join(", "));
            console.error("[admin-db] Note: You must configure these variables in the Cloudflare Pages Dashboard -> Settings -> Environment variables -> Production/Preview.");
            return new Response(JSON.stringify({ 
                error: 'Server configuration error', 
                details: `Missing environment variables: ${missingEnvVars.join(', ')}. Please configure them in Cloudflare Pages settings.` 
            }), { status: 500, headers: corsHeaders });
        }

        // 2. Validate user using Supabase Auth (with anon key to verify token)
        const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
            headers: {
                'apikey': anonKey,
                'Authorization': `Bearer ${token}`
            }
        });

        if (!authRes.ok) {
            return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { status: 401, headers: corsHeaders });
        }

        const user = await authRes.json();
        
        // 3. Admin Role Check
        // Scalable check: User metadata role === 'admin' OR legacy internal domain mapping
        const isLegacyAdmin = user.email && user.email.endsWith('@padmajahomefoods.internal');
        const isRoleAdmin = user.user_metadata && user.user_metadata.role === 'admin';
        
        if (!isLegacyAdmin && !isRoleAdmin) {
            return new Response(JSON.stringify({ error: 'Forbidden. Admin privileges required.' }), { status: 403, headers: corsHeaders });
        }

        // 4. Parse request payload
        const body = await context.request.json();
        const { table, action, match, inFilter, order, payload, selectColumns = '*' } = body;

        if (!table || !action) {
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

        const dbRes = await fetch(endpoint, {
            method: method,
            headers: fetchHeaders,
            body: fetchBody
        });

        if (!dbRes.ok) {
            const errText = await dbRes.text();
            return new Response(JSON.stringify({ error: 'Database operation failed', details: errText }), { status: dbRes.status, headers: corsHeaders });
        }

        const responseText = await dbRes.text();
        let data = null;
        if (responseText) {
            try {
                data = JSON.parse(responseText);
            } catch (e) {}
        }

        return new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: 'Internal Server Error', details: err.message }), { 
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
