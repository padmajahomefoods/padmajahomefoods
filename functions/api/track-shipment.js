// ============================================
// Cloudflare Pages Function — Courier Tracking API (V4 REST JSON Spec)
// Route: POST /api/track-shipment
// Environment Variables: DTDC_USERNAME, DTDC_PASSWORD, DTDC_ENV (optional)
// ============================================

// --------------------------------------------
// Adapter Architecture for Multiple Providers
// --------------------------------------------

class DTDCTrackingProvider {
    constructor(env) {
        this.username = env.DTDC_USERNAME || '';
        this.password = env.DTDC_PASSWORD || '';
        // Fallback static token if configured
        this.staticToken = env.DTDC_ACCESS_TOKEN || env.DTDC_API_KEY || '';
        
        // Use Official Staging or Production endpoints based on DTDC_ENV
        const isStaging = env.DTDC_ENV && env.DTDC_ENV.toLowerCase() === 'staging';
        this.authUrl = env.DTDC_AUTH_URL || (
            isStaging 
                ? 'https://dtdcstagingapi.dtdc.com/dtdc-api/api/dtdc/authenticate' 
                : 'https://blktracksvc.dtdc.com/dtdc-api/api/dtdc/authenticate'
        );
        this.trackingUrl = env.DTDC_TRACK_URL || (
            isStaging 
                ? 'https://dtdcstagingapi.dtdc.com/dtdc-api/rest/JSONCnTrk/getTrackDetails' 
                : 'https://blktracksvc.dtdc.com/dtdc-api/rest/JSONCnTrk/getTrackDetails'
        );
        this.accessToken = null;
    }

    async getAccessToken() {
        if (this.accessToken) {
            return { error: false, token: this.accessToken };
        }

        // 1. Execute official token generation handshake using DTDC_USERNAME and DTDC_PASSWORD
        if (this.username && this.password) {
            try {
                const urlObj = new URL(this.authUrl);
                urlObj.searchParams.set('username', this.username);
                urlObj.searchParams.set('password', this.password);
                const authRequestUrl = urlObj.toString();

                console.log('[DTDCTrackingProvider] --- OUTGOING DTDC AUTH REQUEST ---');
                console.log('[DTDCTrackingProvider] HTTP Method: GET');
                console.log('[DTDCTrackingProvider] Auth URL:', this.authUrl + '?username=<REDACTED>&password=<REDACTED>');

                const response = await fetch(authRequestUrl, { method: 'GET' });
                const status = response.status;
                const responseText = await response.text();

                console.log('[DTDCTrackingProvider] --- DTDC AUTH RESPONSE ---');
                console.log('[DTDCTrackingProvider] Status Code:', status);
                console.log('[DTDCTrackingProvider] Token Access Key received:', status === 200 ? '<REDACTED_SUCCESS>' : responseText.slice(0, 200));

                if (!response.ok || status !== 200) {
                    return {
                        error: true,
                        status: status,
                        message: `Authentication rejected by DTDC API (HTTP ${status}): ${responseText.slice(0, 150)}`
                    };
                }

                let token = responseText.trim();
                try {
                    if (token.startsWith('{') || token.startsWith('[')) {
                        const json = JSON.parse(token);
                        token = json.token || json.access_token || json.tokenAccessKey || json.TokenAccessKey || json.key || token;
                    }
                } catch (e) {}

                if (!token) {
                    return { error: true, status: 200, message: 'DTDC authenticate returned an empty token access key.' };
                }

                this.accessToken = token;
                return { error: false, token: this.accessToken };

            } catch (authErr) {
                console.error('[DTDCTrackingProvider] Network exception during DTDC authenticate:', authErr);
                return { error: true, status: 500, message: `Auth network exception: ${authErr.message || authErr}` };
            }
        }

        // 2. Fallback to pre-generated static access token if credentials are not provided
        if (this.staticToken) {
            this.accessToken = this.staticToken;
            return { error: false, token: this.accessToken };
        }

        return {
            error: true,
            status: 401,
            message: 'DTDC credentials (DTDC_USERNAME and DTDC_PASSWORD) are not configured in environment variables.'
        };
    }

    async track(trackingNumber) {
        if (!trackingNumber || trackingNumber.trim() === '') {
            return { success: false, error_type: 'INVALID_TRACKING', message: 'Tracking number is required.' };
        }

        // Step 1: Perform authentic V4 authentication handshake
        const authResult = await this.getAccessToken();
        if (authResult.error) {
            console.error('[DTDCTrackingProvider] Auth handshake failed:', authResult.message);
            return {
                success: false,
                error_type: 'API_UNAVAILABLE',
                message: `DTDC API Authentication Error: ${authResult.message}`,
                debug_info: {
                    endpoint: 'authenticate',
                    status_code: authResult.status || 500,
                    error: authResult.message
                }
            };
        }

        // Step 2: Construct V4 Tracking Request
        const requestBody = {
            trkType: 'cnno',
            strcnno: trackingNumber.trim(),
            addtnlDtl: 'Y'
        };

        console.log('[DTDCTrackingProvider] --- OUTGOING DTDC V4 API REQUEST ---');
        console.log('[DTDCTrackingProvider] HTTP Method: POST');
        console.log('[DTDCTrackingProvider] Request URL:', this.trackingUrl);
        console.log('[DTDCTrackingProvider] Headers: { "Content-Type": "application/json", "x-access-token": "<REDACTED>" }');
        console.log('[DTDCTrackingProvider] Request Body:', JSON.stringify(requestBody));

        let statusCode = 0;
        let responseText = '';
        let targetUrl = this.trackingUrl;

        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-access-token': authResult.token
                },
                body: JSON.stringify(requestBody)
            });

            statusCode = response.status;
            responseText = await response.text();

            console.log('[DTDCTrackingProvider] --- DTDC V4 API RESPONSE ---');
            console.log('[DTDCTrackingProvider] Status Code:', statusCode);
            console.log('[DTDCTrackingProvider] Response Body:', responseText);

            const debugInfo = {
                url: targetUrl,
                method: 'POST',
                status_code: statusCode,
                request_body: requestBody,
                response_body: responseText
            };

            if (!response.ok) {
                console.error(`[DTDCTrackingProvider] V4 tracking call failed with HTTP ${statusCode}`);
                return {
                    success: false,
                    error_type: (statusCode === 404 || statusCode === 400) ? 'INVALID_TRACKING' : 'API_UNAVAILABLE',
                    message: `DTDC Tracking API error: HTTP ${statusCode}. Response: ${responseText.slice(0, 300)}`,
                    debug_info: debugInfo
                };
            }

            let rawData = null;
            try {
                rawData = JSON.parse(responseText);
            } catch (e) {
                console.error('[DTDCTrackingProvider] Failed to parse JSON response text.');
                return {
                    success: false,
                    error_type: 'API_UNAVAILABLE',
                    message: 'Invalid JSON response received from DTDC API.',
                    debug_info: debugInfo
                };
            }

            // Step 3: Handle V4 document error Details and failure flags
            if (rawData && (rawData.statusFlag === false || rawData.status === 'FAILED' || (rawData.errorDetails && rawData.errorDetails.length > 0))) {
                let errorMessage = 'Tracking number not found or currently unavailable in DTDC system.';
                if (Array.isArray(rawData.errorDetails)) {
                    const errObj = rawData.errorDetails.find(e => e.name === 'strError' || (e.value && e.value !== trackingNumber.trim()));
                    if (errObj && errObj.value) {
                        errorMessage = errObj.value;
                    }
                }
                return {
                    success: false,
                    error_type: 'INVALID_TRACKING',
                    message: errorMessage,
                    debug_info: debugInfo
                };
            }

            if (!rawData || !rawData.trackDetails || !Array.isArray(rawData.trackDetails) || rawData.trackDetails.length === 0) {
                return {
                    success: false,
                    error_type: 'INVALID_TRACKING',
                    message: 'No tracking milestone updates reported by DTDC yet.',
                    debug_info: debugInfo
                };
            }

            // Step 4: Parse V4 trackHeader & trackDetails into normalized UI schema
            const header = rawData.trackHeader || {};
            const details = rawData.trackDetails;

            const events = details.map((evt, idx) => {
                let formattedTime = '';
                let unixTimestamp = 0;

                // Parse strActionDate (DDMMYYYY e.g., "26052025") and strActionTime (HHMM e.g., "1013" or "0639")
                if (evt.strActionDate) {
                    try {
                        const dateStr = String(evt.strActionDate).trim();
                        if (dateStr.length === 8) {
                            const day = parseInt(dateStr.substring(0, 2), 10);
                            const month = parseInt(dateStr.substring(2, 4), 10) - 1; // JS 0-indexed month
                            const year = parseInt(dateStr.substring(4, 8), 10);

                            let hour = 0;
                            let minute = 0;
                            if (evt.strActionTime) {
                                const timeStr = String(evt.strActionTime).trim().padStart(4, '0');
                                if (timeStr.length === 4) {
                                    hour = parseInt(timeStr.substring(0, 2), 10) || 0;
                                    minute = parseInt(timeStr.substring(2, 4), 10) || 0;
                                }
                            }

                            const dateObj = new Date(year, month, day, hour, minute);
                            if (!isNaN(dateObj.getTime())) {
                                unixTimestamp = dateObj.getTime();
                                formattedTime = dateObj.toLocaleString('en-IN', {
                                    day: '2-digit',
                                    month: 'short',
                                    year: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: true
                                });
                            }
                        }
                    } catch (e) {
                        console.error('[DTDCTrackingProvider] Error parsing date/time:', e);
                    }
                }

                if (!formattedTime && evt.strActionDate) {
                    formattedTime = `${evt.strActionDate} ${evt.strActionTime || ''}`.trim();
                }

                return {
                    customer_update: evt.strAction || evt.strCode || 'Milestone Update',
                    location: evt.strOrigin || evt.strOriginCode || '',
                    time: formattedTime,
                    remarks: evt.strRemarks || evt.sTrRemarks || '',
                    raw_time: unixTimestamp,
                    original_idx: idx
                };
            });

            // Sort newest event first (descending by timestamp; fallback to descending array index)
            events.sort((a, b) => {
                if (b.raw_time === a.raw_time) {
                    return b.original_idx - a.original_idx;
                }
                return b.raw_time - a.raw_time;
            });

            const timeline = events.map(({ raw_time, original_idx, ...rest }) => rest);
            const overallStatus = header.strStatus || (timeline[0] ? timeline[0].customer_update : 'In Transit');

            return {
                success: true,
                courier_name: 'DTDC',
                tracking_number: header.strShipmentNo || trackingNumber,
                status: overallStatus,
                timeline: timeline,
                debug_info: debugInfo
            };

        } catch (error) {
            console.error('[DTDCTrackingProvider] Network or execution exception during tracking query:', error);
            return {
                success: false,
                error_type: 'API_UNAVAILABLE',
                message: `Network exception during tracking lookup: ${error.message || error}`,
                debug_info: { url: targetUrl, method: 'POST', exception: String(error) }
            };
        }
    }
}



class NimbuspostTrackingProvider {
    constructor(env) {
        this.email = env.NIMBUSPOST_EMAIL || '';
        this.password = env.NIMBUSPOST_PASSWORD || '';
        this.staticToken = env.NIMBUSPOST_TOKEN || '';
        this.authUrl = 'https://ship.nimbuspost.com/api/users/login';
        this.trackUrlBase = 'https://ship.nimbuspost.com/api/shipmentcargo/track/';
        this.accessToken = null;
    }

    async getAccessToken() {
        if (this.accessToken) return { error: false, token: this.accessToken };

        if (this.staticToken) {
            this.accessToken = this.staticToken;
            return { error: false, token: this.accessToken };
        }

        if (this.email && this.password) {
            try {
                console.log('[NimbuspostTrackingProvider] --- OUTGOING AUTH REQUEST ---');
                console.log('[NimbuspostTrackingProvider] HTTP Method: POST');
                console.log('[NimbuspostTrackingProvider] Auth URL:', this.authUrl);
                
                const response = await fetch(this.authUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: this.email, password: this.password })
                });

                const status = response.status;
                const responseText = await response.text();
                
                console.log('[NimbuspostTrackingProvider] --- AUTH RESPONSE ---');
                console.log('[NimbuspostTrackingProvider] Status:', status);
                console.log('[NimbuspostTrackingProvider] Body:', status === 200 ? '<REDACTED_SUCCESS>' : responseText.slice(0, 200));

                if (!response.ok) {
                    return { error: true, status, message: `Nimbuspost Auth failed: HTTP ${status}` };
                }

                let json;
                try {
                    json = JSON.parse(responseText);
                } catch (e) {
                    return { error: true, status: 500, message: 'Invalid JSON from Nimbuspost Auth' };
                }

                if (json.status === true && json.data) {
                    this.accessToken = json.data;
                    return { error: false, token: this.accessToken };
                } else {
                    return { error: true, status: 200, message: 'Auth failed: Token not found in response' };
                }
            } catch (err) {
                console.error('[NimbuspostTrackingProvider] Auth network exception:', err);
                return { error: true, status: 500, message: `Auth exception: ${err.message || err}` };
            }
        }

        return {
            error: true,
            status: 401,
            message: 'Nimbuspost credentials (NIMBUSPOST_EMAIL and NIMBUSPOST_PASSWORD) are not configured.'
        };
    }

    async track(trackingNumber) {
        if (!trackingNumber || trackingNumber.trim() === '') {
            return { success: false, error_type: 'INVALID_TRACKING', message: 'Tracking number is required.' };
        }

        const authResult = await this.getAccessToken();
        if (authResult.error) {
            console.error('[NimbuspostTrackingProvider] Auth handshake failed:', authResult.message);
            return {
                success: false,
                error_type: 'API_UNAVAILABLE',
                message: `Nimbuspost Authentication Error: ${authResult.message}`,
                debug_info: { endpoint: 'login', error: authResult.message }
            };
        }

        const targetUrl = this.trackUrlBase + encodeURIComponent(trackingNumber.trim());

        console.log('[NimbuspostTrackingProvider] --- OUTGOING TRACKING REQUEST ---');
        console.log('[NimbuspostTrackingProvider] HTTP Method: GET');
        console.log('[NimbuspostTrackingProvider] URL:', targetUrl);

        try {
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${authResult.token}`,
                    'Content-Type': 'application/json'
                }
            });

            const statusCode = response.status;
            const responseText = await response.text();

            console.log('[NimbuspostTrackingProvider] --- TRACKING RESPONSE ---');
            console.log('[NimbuspostTrackingProvider] Status Code:', statusCode);
            console.log('[NimbuspostTrackingProvider] Response Body:', responseText);

            const debugInfo = { url: targetUrl, method: 'GET', status_code: statusCode, response_body: responseText };

            let rawData;
            try {
                rawData = JSON.parse(responseText);
            } catch (e) {
                return { success: false, error_type: 'API_UNAVAILABLE', message: 'Invalid JSON response from Nimbuspost', debug_info: debugInfo };
            }

            if (!response.ok || rawData.status === false) {
                // Determine if it's invalid tracking vs unavailable API
                const isInvalid = statusCode === 404 || (rawData.message && String(rawData.message).toLowerCase().includes('not found'));
                return {
                    success: false,
                    error_type: isInvalid ? 'INVALID_TRACKING' : 'API_UNAVAILABLE',
                    message: rawData.message || `API Error HTTP ${statusCode}`,
                    debug_info: debugInfo
                };
            }

            const data = rawData.data;
            if (!data || !data.history || !Array.isArray(data.history) || data.history.length === 0) {
                return {
                    success: false,
                    error_type: 'INVALID_TRACKING',
                    message: 'No tracking history found for this shipment.',
                    debug_info: debugInfo
                };
            }

            const events = data.history.map((evt, idx) => {
                let formattedTime = evt.event_time || '';
                let unixTimestamp = 0;

                if (evt.event_time) {
                    try {
                        const dateObj = new Date(evt.event_time);
                        if (!isNaN(dateObj.getTime())) {
                            unixTimestamp = dateObj.getTime();
                            formattedTime = dateObj.toLocaleString('en-IN', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: true
                            });
                        }
                    } catch (e) {}
                }

                return {
                    customer_update: evt.message || evt.status_code || 'Update',
                    location: evt.location || '',
                    time: formattedTime,
                    raw_time: unixTimestamp,
                    original_idx: idx
                };
            });

            // Sort newest first
            events.sort((a, b) => {
                if (b.raw_time === a.raw_time) {
                    return b.original_idx - a.original_idx; // fallback to index based on their API response logic (assume returned order is chronological)
                }
                return b.raw_time - a.raw_time;
            });

            const timeline = events.map(({ raw_time, original_idx, ...rest }) => rest);
            const overallStatus = data.status || (timeline[0] ? timeline[0].customer_update : 'In Transit');

            return {
                success: true,
                courier_name: 'Nimbuspost',
                tracking_number: data.awb_number || trackingNumber,
                status: overallStatus,
                timeline: timeline,
                debug_info: debugInfo
            };
        } catch (error) {
            console.error('[NimbuspostTrackingProvider] Network exception:', error);
            return {
                success: false,
                error_type: 'API_UNAVAILABLE',
                message: `Network exception: ${error.message || error}`,
                debug_info: { url: targetUrl, method: 'GET', exception: String(error) }
            };
        }
    }
}
class DelhiveryTrackingProvider {
    constructor(env) {
        this.apiToken = env.DELHIVERY_API_TOKEN || '';
        this.trackUrlBase = 'https://track.delhivery.com/api/v1/packages/json/?waybill=';
    }

    // Helper to deeply search the JSON for the most likely tracking events array
    findTrackingArray(obj) {
        let bestArray = [];
        const search = (current) => {
            if (Array.isArray(current)) {
                if (current.length > 0 && typeof current[0] === 'object' && current[0] !== null) {
                    // Flatten to check nested keys (e.g. Scans: [{ ScanDetail: { ScanDateTime: ... } }])
                    const sample = this.extractEventDetails(current[0]);
                    const hasTime = !!sample.eventTimeStr;
                    const hasStatus = sample.customerUpdate !== 'Update';
                    
                    if (hasTime && hasStatus && current.length > bestArray.length) {
                        bestArray = current;
                    }
                }
                for (const item of current) {
                    if (typeof item === 'object' && item !== null) search(item);
                }
            } else if (typeof current === 'object' && current !== null) {
                for (const key in current) {
                    search(current[key]);
                }
            }
        };
        search(obj);
        return bestArray;
    }

    // Helper to extract fields dynamically from an unknown event object
    extractEventDetails(evtObj) {
        // Flatten nested objects (e.g. ScanDetail: { Scan: '...', ScannedLocation: '...' })
        const flatObj = {};
        const flatten = (obj, prefix = '') => {
            if (typeof obj !== 'object' || obj === null) return;
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
                    flatten(v, prefix + k + '_');
                } else if (typeof v === 'string' || typeof v === 'number') {
                    flatObj[(prefix + k).toLowerCase()] = String(v);
                }
            }
        };
        flatten(evtObj);

        let customerUpdate = 'Update';
        let location = '';
        let eventTimeStr = '';

        // Priority heuristics for mapping keys
        for (const key in flatObj) {
            const val = flatObj[key];
            if (!val) continue;

            if ((key.includes('status') || key.includes('scan') || key.includes('activity') || key.includes('instruction') || key.includes('remark')) && !key.includes('date') && !key.includes('time')) {
                if (customerUpdate === 'Update' || val.length > customerUpdate.length) {
                    customerUpdate = val;
                }
            }
            if (key.includes('location') || key.includes('origin') || key.includes('destination') || key.includes('hub')) {
                location = val;
            }
            if (key.includes('date') || key.includes('time')) {
                // Prefer longer date strings (e.g. "2023-05-19 19:29" over "2023-05-19")
                if (val.length > eventTimeStr.length) {
                    eventTimeStr = val;
                }
            }
        }

        let unixTimestamp = 0;
        let formattedTime = eventTimeStr;
        if (eventTimeStr) {
            const parsed = Date.parse(eventTimeStr);
            if (!isNaN(parsed)) {
                unixTimestamp = parsed;
                formattedTime = new Date(parsed).toLocaleString('en-IN', {
                    day: '2-digit', month: 'short', year: 'numeric',
                    hour: '2-digit', minute: '2-digit', hour12: true
                });
            }
        }

        return { customerUpdate, location, eventTimeStr: formattedTime, unixTimestamp };
    }

    async track(trackingNumber) {
        if (!trackingNumber || trackingNumber.trim() === '') {
            return { success: false, error_type: 'INVALID_TRACKING', message: 'Tracking number is required.' };
        }

        if (!this.apiToken) {
            return {
                success: false,
                error_type: 'API_UNAVAILABLE',
                message: 'Delhivery credentials (DELHIVERY_API_TOKEN) are not configured.'
            };
        }

        const targetUrl = this.trackUrlBase + encodeURIComponent(trackingNumber.trim());

        console.log('[DelhiveryTrackingProvider] --- OUTGOING TRACKING REQUEST ---');
        console.log('[DelhiveryTrackingProvider] HTTP Method: GET');
        console.log('[DelhiveryTrackingProvider] URL:', targetUrl);
        console.log('[DelhiveryTrackingProvider] Headers: { "Authorization": "Token <REDACTED>", "Content-Type": "application/json" }');

        try {
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Token ${this.apiToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const statusCode = response.status;
            const responseText = await response.text();

            console.log('[DelhiveryTrackingProvider] --- TRACKING RESPONSE ---');
            console.log('[DelhiveryTrackingProvider] Status Code:', statusCode);
            console.log('[DelhiveryTrackingProvider] Response Body Length:', responseText.length);
            
            // Log full raw JSON for mapping in dev/monitoring
            if (statusCode === 200) {
                console.log('[DelhiveryTrackingProvider] Raw JSON Payload:', responseText.slice(0, 1500) + (responseText.length > 1500 ? '...' : ''));
            }

            const debugInfo = { url: targetUrl, method: 'GET', status_code: statusCode, raw_json: responseText.slice(0, 5000) };

            if (statusCode === 401 || statusCode === 403) {
                return {
                    success: false,
                    error_type: 'API_UNAVAILABLE',
                    message: 'Delhivery API token is unauthorized or expired.',
                    debug_info: debugInfo
                };
            }

            if (statusCode === 429) {
                return {
                    success: false,
                    error_type: 'API_UNAVAILABLE',
                    message: 'Delhivery API rate limit exceeded.',
                    debug_info: debugInfo
                };
            }

            let rawData;
            try {
                rawData = JSON.parse(responseText);
            } catch (e) {
                return { success: false, error_type: 'API_UNAVAILABLE', message: 'Invalid JSON response from Delhivery API.', debug_info: debugInfo };
            }

            if (!response.ok) {
                return {
                    success: false,
                    error_type: statusCode === 404 ? 'INVALID_TRACKING' : 'API_UNAVAILABLE',
                    message: `Delhivery API returned HTTP ${statusCode}`,
                    debug_info: debugInfo
                };
            }

            // Check if Delhivery explicitly returned an error embedded in a 200 OK
            // e.g. {"Error": "Waybill not found"}
            const strRaw = responseText.toLowerCase();
            if (strRaw.includes('not found') || strRaw.includes('invalid') || (rawData.Error && !rawData.ShipmentData)) {
                return {
                    success: false,
                    error_type: 'INVALID_TRACKING',
                    message: rawData.Error || 'Tracking number not found in Delhivery system.',
                    debug_info: debugInfo
                };
            }

            // 1. DYNAMICALLY PARSE TIMELINE ARRAY
            const eventsArray = this.findTrackingArray(rawData);

            if (!eventsArray || eventsArray.length === 0) {
                return {
                    success: false,
                    error_type: 'INVALID_TRACKING', // Possibly invalid if history is empty
                    message: 'No tracking history or milestone events found for this shipment yet.',
                    debug_info: debugInfo
                };
            }

            // 2. EXTRACT EVENT FIELDS
            const timeline = eventsArray.map((evtObj, idx) => {
                const { customerUpdate, location, eventTimeStr, unixTimestamp } = this.extractEventDetails(evtObj);
                return {
                    customer_update: customerUpdate,
                    location: location,
                    time: eventTimeStr,
                    raw_time: unixTimestamp,
                    original_idx: idx
                };
            });

            // 3. SORT CHRONOLOGICALLY (NEWEST FIRST)
            timeline.sort((a, b) => {
                if (b.raw_time === a.raw_time) {
                    return b.original_idx - a.original_idx; // fallback to their returned array order
                }
                return b.raw_time - a.raw_time;
            });

            // 4. DETERMINE OVERALL STATUS
            // Try to find a root "Status" or "Status.Status" field
            let overallStatus = '';
            const findRootStatus = (obj) => {
                if (!obj || typeof obj !== 'object') return;
                for (const [k, v] of Object.entries(obj)) {
                    if (k.toLowerCase() === 'status' && typeof v === 'string') overallStatus = v;
                    else if (k.toLowerCase() === 'status' && typeof v === 'object' && v.Status) overallStatus = v.Status;
                    else if (typeof v === 'object') findRootStatus(v);
                }
            };
            findRootStatus(rawData);

            if (!overallStatus && timeline.length > 0) {
                overallStatus = timeline[0].customer_update; // fallback to newest event
            }

            // Strip internal properties
            const finalTimeline = timeline.map(({ raw_time, original_idx, ...rest }) => rest);

            return {
                success: true,
                courier_name: 'Delhivery',
                tracking_number: trackingNumber,
                status: overallStatus || 'In Transit',
                timeline: finalTimeline,
                debug_info: debugInfo
            };

        } catch (error) {
            console.error('[DelhiveryTrackingProvider] Network exception:', error);
            return {
                success: false,
                error_type: 'API_UNAVAILABLE',
                message: `Network exception during Delhivery tracking lookup: ${error.message || error}`,
                debug_info: { url: targetUrl, method: 'GET', exception: String(error) }
            };
        }
    }
}

class TrackingService {
    constructor(env) {
        this.env = env;
        this.providers = {
            'DTDC': new DTDCTrackingProvider(env),
            'Nimbuspost': new NimbuspostTrackingProvider(env),
            'Delhivery': new DelhiveryTrackingProvider(env)
        };
    }

    async trackShipment(courierName, trackingNumber) {
        if (!courierName || !trackingNumber) {
            return { success: false, error_type: 'INVALID_TRACKING', message: 'Missing courier name or tracking number.' };
        }

        const normalizedCourier = Object.keys(this.providers).find(
            k => k.toLowerCase() === courierName.trim().toLowerCase()
        );

        const provider = this.providers[normalizedCourier];
        if (!provider) {
            return { success: false, error_type: 'INVALID_TRACKING', message: 'Unsupported courier provider.' };
        }

        return await provider.track(trackingNumber);
    }
}

// --------------------------------------------
// Cloudflare Functions Request Handlers
// --------------------------------------------

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: corsHeaders
    });
}

export async function onRequestPost(context) {
    try {
        const body = await context.request.json().catch(() => ({}));
        const { courier_name, tracking_number } = body;

        const trackingService = new TrackingService(context.env);
        const result = await trackingService.trackShipment(courier_name, tracking_number);

        return new Response(JSON.stringify(result), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    } catch (error) {
        console.error('[track-shipment endpoint error]:', error);
        return new Response(JSON.stringify({
            success: false,
            error_type: 'API_UNAVAILABLE',
            message: 'Unable to process tracking request at this time.'
        }), {
            status: 500,
            headers: {
                'Content-Type': 'application/json',
                ...corsHeaders
            }
        });
    }
}
