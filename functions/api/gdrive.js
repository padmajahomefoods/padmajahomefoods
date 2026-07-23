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
        
        console.log("--- DEBUG UPLOAD METADATA ---");
        console.log("folderId:", folderId);
        console.log("metadata object:", JSON.stringify(metadata, null, 2));
        console.log("-----------------------------");

        // Step 1: Initiate Resumable Upload
        const initUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true';
        const initBody = JSON.stringify(metadata);
        console.log("--- DEBUG INIT REQUEST ---");
        console.log("Init URL:", initUrl);
        console.log("Init Body:", initBody);

        const initRes = await fetch(initUrl, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${token}`, 
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Type': file.type,
                'X-Upload-Content-Length': String(file.size)
            },
            body: initBody
        });
        
        const initHeaders = {};
        for (let [key, val] of initRes.headers) { initHeaders[key] = val; }
        console.log("Init Status:", initRes.status);
        console.log("Init Headers:", JSON.stringify(initHeaders));

        if (!initRes.ok) {
            const errTxt = await initRes.text();
            let rawJson = errTxt;
            try { rawJson = JSON.parse(errTxt); } catch(e) {}
            return new Response(JSON.stringify({ 
                error: 'Google Drive API Init Error', 
                folderId: folderId,
                initRequestBody: JSON.parse(initBody),
                initResponseHeaders: initHeaders,
                status: initRes.status,
                rawResponse: rawJson
            }, null, 2), { status: 500, headers: corsHeaders });
        }

        const locationUrl = initRes.headers.get('Location');
        if (!locationUrl) {
            return new Response(JSON.stringify({ 
                error: 'Failed to retrieve resumable upload URL',
                initResponseHeaders: initHeaders
            }, null, 2), { status: 500, headers: corsHeaders });
        }

        // Step 2: Upload File Bytes
        const fileBytes = await file.arrayBuffer();
        const uploadRes = await fetch(locationUrl, {
            method: 'PUT',
            headers: { 
                'Content-Length': String(file.size),
                'Content-Type': file.type 
            },
            body: fileBytes
        });

        const uploadResText = await uploadRes.text();
        
        console.log("--- DEBUG UPLOAD RESPONSE ---");
        console.log("uploadRes status:", uploadRes.status);
        console.log("uploadRes body:", uploadResText);
        console.log("-----------------------------");
        
        if (!uploadRes.ok) {
            let rawJson = uploadResText;
            try { rawJson = JSON.parse(uploadResText); } catch(e) {}
            
            return new Response(JSON.stringify({ 
                error: 'Google Drive API Upload Error', 
                resolvedParentFolderId: folderId,
                initRequestBody: JSON.parse(initBody),
                initResponseHeaders: initHeaders,
                uploadUrl: locationUrl,
                status: uploadRes.status,
                rawResponse: rawJson
            }, null, 2), { status: 500, headers: corsHeaders });
        }
        
        const uploadData = JSON.parse(uploadResText);
        return new Response(JSON.stringify({ 
            success: true, 
            fileId: uploadData.id,
            name: uploadData.name,
            type: uploadData.mimeType,
            size: uploadData.size
        }), { status: 200, headers: corsHeaders });

    } catch (e) {
        console.error(e);
        return new Response(JSON.stringify({ 
            error: 'Internal server exception', 
            details: e.message || String(e), 
            stack: e.stack 
        }, null, 2), { status: 500, headers: corsHeaders });
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
