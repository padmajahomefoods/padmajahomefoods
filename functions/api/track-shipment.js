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

class DelhiveryTrackingProvider {
    constructor(env) {
        this.env = env;
    }

    async track(trackingNumber) {
        return {
            success: false,
            error_type: 'INVALID_TRACKING',
            message: 'Live tracking for Delhivery will be available soon.'
        };
    }
}

class TrackingService {
    constructor(env) {
        this.env = env;
        this.providers = {
            'DTDC': new DTDCTrackingProvider(env),
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
