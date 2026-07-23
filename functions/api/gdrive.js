// Google Drive API Integration for Cloudflare Pages Functions
// Secure Implementation

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    let allowedOrigin = 'https://padmajahomefoods.com';
    
    // Allow localhost in development
    if (origin.startsWith('http://localhost:')) {
        allowedOrigin = origin;
    }
    
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-anon-key',
    };
}

export async function onRequestOptions(context) {
    return new Response(null, { headers: getCorsHeaders(context.request) });
}

// JWT Utilities
function base64url(source) {
    let encoded = btoa(source);
    encoded = encoded.replace(/=+$/, '');
    encoded = encoded.replace(/\+/g, '-');
    encoded = encoded.replace(/\//g, '_');
    return encoded;
}

async function importPrivateKey(pem) {
    const pemHeader = "-----BEGIN PRIVATE KEY-----";
    const pemFooter = "-----END PRIVATE KEY-----";
    const formattedPem = (pem || '').replace(/\\n/g, '\n');
    
    if (!formattedPem.includes(pemHeader) || !formattedPem.includes(pemFooter)) {
        throw new Error("Invalid private key format: Missing BEGIN/END PRIVATE KEY header/footer");
    }

    const pemContents = formattedPem.substring(
        formattedPem.indexOf(pemHeader) + pemHeader.length,
        formattedPem.indexOf(pemFooter)
    ).replace(/\s/g, '');
    
    const binaryDerString = atob(pemContents);
    const binaryDer = new ArrayBuffer(binaryDerString.length);
    const bufView = new Uint8Array(binaryDer);
    for (let i = 0; i < binaryDerString.length; i++) {
        bufView[i] = binaryDerString.charCodeAt(i);
    }

    return await crypto.subtle.importKey(
        "pkcs8",
        binaryDer,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        true,
        ["sign"]
    );
}

async function createJwt(clientEmail, privateKeyPem) {
    const header = { alg: "RS256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const claim = {
        iss: clientEmail,
        scope: "https://www.googleapis.com/auth/drive",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600,
        iat: now
    };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedClaim = base64url(JSON.stringify(claim));
    const token = `${encodedHeader}.${encodedClaim}`;

    const privateKey = await importPrivateKey(privateKeyPem);
    const signatureBuffer = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        privateKey,
        new TextEncoder().encode(token)
    );

    const signature = base64url(String.fromCharCode(...new Uint8Array(signatureBuffer)));
    return `${token}.${signature}`;
}

async function getAccessToken(env) {
    const reqVars = ['GDRIVE_CLIENT_EMAIL', 'GDRIVE_PRIVATE_KEY', 'GDRIVE_PROJECT_ID', 'GDRIVE_PRIVATE_KEY_ID', 'GDRIVE_FOLDER_ID'];
    let missing = [];
    let statusText = [];
    
    for (const v of reqVars) {
        if (env[v]) {
            statusText.push(`✓ ${v}`);
        } else {
            statusText.push(`✗ ${v} (missing)`);
            missing.push(v);
        }
    }
    
    if (missing.length > 0) {
        const errorMsg = `Configuration Error:\n${statusText.join('\n')}\nMissing variables: ${missing.join(', ')}`;
        throw new Error(errorMsg);
    }
    
    const clientEmail = env.GDRIVE_CLIENT_EMAIL;
    const privateKey = env.GDRIVE_PRIVATE_KEY;

    const jwt = await createJwt(clientEmail, privateKey);
    const req = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
    });
    
    if (!req.ok) {
        throw new Error(`Internal auth error [${req.status}]: ` + await req.text());
    }
    const res = await req.json();
    return res.access_token;
}

async function getOrCreateFolder(token, name, parentId = 'root') {
    const q = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
        throw new Error(`Failed to query folder '${name}' [${res.status}]: ` + await res.text() + ` | URL: ${res.url}`);
    }
    const data = await res.json();
    if (data.files && data.files.length > 0) return data.files[0].id;
    
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    if (!createRes.ok) {
        throw new Error(`Failed to create folder '${name}' [${createRes.status}]: ` + await createRes.text() + ` | URL: ${createRes.url}`);
    }
    const createData = await createRes.json();
    return createData.id;
}

// Security: Verify Admin
async function requireAdminAuth(context, corsHeaders) {
    let authHeader = context.request.headers.get('Authorization');
    let anonKey = context.request.headers.get('x-anon-key');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
    }
    const token = authHeader.split(' ')[1];

    if (!anonKey) {
        anonKey = context.env.SUPABASE_ANON_KEY;
        if (!anonKey) return new Response(JSON.stringify({ error: 'Internal config error' }), { status: 500, headers: corsHeaders });
    }

    const supabaseUrl = context.env.SUPABASE_URL;
    if (!supabaseUrl) return new Response(JSON.stringify({ error: 'Internal config error' }), { status: 500, headers: corsHeaders });

    const authRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { 'apikey': anonKey, 'Authorization': `Bearer ${token}` }
    });

    if (!authRes.ok) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });

    const user = await authRes.json();
    const isLegacyAdmin = user.email && user.email.endsWith('@padmajahomefoods.internal');
    const isRoleAdmin = user.user_metadata && user.user_metadata.role === 'admin';
    
    if (!isLegacyAdmin && !isRoleAdmin) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders });
    }
    
    return null; // Passed
}

export async function onRequestPost(context) {
    const corsHeaders = getCorsHeaders(context.request);
    try {
        const authErr = await requireAdminAuth(context, corsHeaders);
        if (authErr) return authErr;

        let token;
        try {
            token = await getAccessToken(context.env);
        } catch(e) {
            console.error(e);
            return new Response(JSON.stringify({ error: 'Internal server error', details: e.message || String(e), stack: e.stack }), { status: 500, headers: corsHeaders });
        }

        const formData = await context.request.formData();
        const file = formData.get('file');
        
        if (!file) return new Response(JSON.stringify({ error: 'No file provided' }), { status: 400, headers: corsHeaders });

        // File Validation
        const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.type)) {
            return new Response(JSON.stringify({ error: 'Invalid file type. Only PDF, JPG, PNG, and WEBP are allowed.' }), { status: 400, headers: corsHeaders });
        }
        if (file.size > 10 * 1024 * 1024) {
            return new Response(JSON.stringify({ error: 'File exceeds 10MB limit.' }), { status: 400, headers: corsHeaders });
        }
        if (!file.name || typeof file.name !== 'string' || file.name.trim() === '') {
            return new Response(JSON.stringify({ error: 'Invalid filename.' }), { status: 400, headers: corsHeaders });
        }

        const rootFolderId = context.env.GDRIVE_FOLDER_ID;
        const f1 = await getOrCreateFolder(token, 'Padmaja Home Foods', rootFolderId);
        const f2 = await getOrCreateFolder(token, 'Expenses', f1);
        const now = new Date();
        const year = now.getFullYear().toString();
        const f3 = await getOrCreateFolder(token, year, f2);
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const monthName = monthNames[now.getMonth()];
        const monthNum = String(now.getMonth() + 1).padStart(2, '0');
        const folderName = `${monthNum}-${monthName}`;
        const folderId = await getOrCreateFolder(token, folderName, f3);

        const metadata = { name: file.name, parents: [folderId] };
        const boundary = '-------314159265358979323846';
        
        const blob = new Blob([
            `--${boundary}\r\n`,
            'Content-Type: application/json; charset=UTF-8\r\n\r\n',
            JSON.stringify(metadata),
            `\r\n--${boundary}\r\n`,
            `Content-Type: ${file.type}\r\n\r\n`,
            file,
            `\r\n--${boundary}--\r\n`
        ]);
        
        const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size&supportsAllDrives=true', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
            body: blob
        });
        
        if (!uploadRes.ok) {
            const errTxt = await uploadRes.text();
            console.error(errTxt);
            return new Response(JSON.stringify({ 
                error: 'Internal upload error', 
                details: errTxt,
                status: uploadRes.status,
                url: uploadRes.url
            }), { status: 500, headers: corsHeaders });
        }
        
        const uploadData = await uploadRes.json();
        return new Response(JSON.stringify({ 
            success: true, 
            fileId: uploadData.id,
            name: uploadData.name,
            type: uploadData.mimeType,
            size: uploadData.size
        }), { status: 200, headers: corsHeaders });

    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ error: 'Internal server error', details: e.message || String(e) }), { status: 500, headers: corsHeaders });
    }
}

export async function onRequestGet(context) {
    const corsHeaders = getCorsHeaders(context.request);
    try {
        const authErr = await requireAdminAuth(context, corsHeaders);
        if (authErr) return authErr;

        const url = new URL(context.request.url);
        const fileId = url.searchParams.get('fileId');
        const action = url.searchParams.get('action');
        
        if (!fileId || typeof fileId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return new Response(JSON.stringify({ error: 'Missing or invalid fileId format' }), { status: 400, headers: corsHeaders });
        
        let token;
        try { token = await getAccessToken(context.env); } catch(e) { return new Response(JSON.stringify({ error: 'Internal server error', details: e.message || String(e), stack: e.stack }), { status: 500, headers: corsHeaders }); }

        const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!metaRes.ok) return new Response(JSON.stringify({ error: 'File not found' }), { status: 404, headers: corsHeaders });
        const meta = await metaRes.json();

        const fileRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!fileRes.ok) return new Response(JSON.stringify({ error: 'Failed to stream file' }), { status: 500, headers: corsHeaders });

        const headers = new Headers(corsHeaders);
        headers.set('Content-Type', meta.mimeType);
        if (action === 'download') {
            headers.set('Content-Disposition', `attachment; filename="${meta.name}"`);
        } else {
            headers.set('Content-Disposition', `inline; filename="${meta.name}"`);
        }

        return new Response(fileRes.body, { status: 200, headers });
    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ error: 'Internal server error', details: e.message || String(e) }), { status: 500, headers: corsHeaders });
    }
}

export async function onRequestDelete(context) {
    const corsHeaders = getCorsHeaders(context.request);
    try {
        const authErr = await requireAdminAuth(context, corsHeaders);
        if (authErr) return authErr;

        const url = new URL(context.request.url);
        const fileId = url.searchParams.get('fileId');
        
        if (!fileId || typeof fileId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fileId)) return new Response(JSON.stringify({ error: 'Missing or invalid fileId format' }), { status: 400, headers: corsHeaders });
        
        let token;
        try { token = await getAccessToken(context.env); } catch(e) { return new Response(JSON.stringify({ error: 'Internal server error', details: e.message || String(e), stack: e.stack }), { status: 500, headers: corsHeaders }); }

        const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!delRes.ok) {
            console.error(await delRes.text());
            return new Response(JSON.stringify({ error: 'Internal delete error' }), { status: 500, headers: corsHeaders });
        }

        return new Response(JSON.stringify({ success: true }), { status: 200, headers: corsHeaders });
    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ error: 'Internal server error', details: e.message || String(e) }), { status: 500, headers: corsHeaders });
    }
}
