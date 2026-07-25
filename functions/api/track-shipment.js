// ============================================
// Cloudflare Pages Function — Courier Tracking API
// Route: POST /api/track-shipment
// Environment Variables: DTDC_API_KEY, DTDC_API_URL (optional)
// ============================================

// --------------------------------------------
// Adapter Architecture for Multiple Providers
// --------------------------------------------

class DTDCTrackingProvider {
    constructor(env) {
        this.apiKey = env.DTDC_API_KEY || '';
        this.apiUrl = env.DTDC_API_URL || 'https://blktracksvc.dtdc.com/dtdc-api/rest/JSONSchema/trackingByAwb';
    }

    async track(trackingNumber) {
        if (!trackingNumber || trackingNumber.trim() === '') {
            return { success: false, error_type: 'INVALID_TRACKING' };
        }

        if (!this.apiKey) {
            console.error('[DTDCTrackingProvider] DTDC_API_KEY environment variable is not configured.');
            return { 
                success: false, 
                error_type: 'API_UNAVAILABLE',
                debug_info: { error: 'DTDC_API_KEY environment variable missing on server.' }
            };
        }

        // Construct GET URL with reference_number parameter as documented
        let targetUrl;
        try {
            const urlObj = new URL(this.apiUrl);
            urlObj.searchParams.set('reference_number', trackingNumber.trim());
            targetUrl = urlObj.toString();
        } catch (e) {
            const sep = this.apiUrl.includes('?') ? '&' : '?';
            targetUrl = `${this.apiUrl}${sep}reference_number=${encodeURIComponent(trackingNumber.trim())}`;
        }

        console.log('[DTDCTrackingProvider] --- OUTGOING DTDC API REQUEST ---');
        console.log('[DTDCTrackingProvider] HTTP Method: GET');
        console.log('[DTDCTrackingProvider] Request URL:', targetUrl);
        console.log('[DTDCTrackingProvider] Query Parameters: reference_number=' + trackingNumber.trim());
        console.log('[DTDCTrackingProvider] Headers: { "api-key": <REDACTED>, "Accept": "application/json" }');

        try {
            const response = await fetch(targetUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'api-key': this.apiKey
                }
            });

            const statusCode = response.status;
            const responseText = await response.text();

            console.log('[DTDCTrackingProvider] --- DTDC API RESPONSE ---');
            console.log('[DTDCTrackingProvider] Status Code:', statusCode);
            console.log('[DTDCTrackingProvider] Response Body:', responseText);

            const debugInfo = {
                url: targetUrl,
                method: 'GET',
                status_code: statusCode,
                response_body: responseText
            };

            if (!response.ok) {
                console.error(`[DTDCTrackingProvider] API failed with HTTP ${statusCode}`);
                return { 
                    success: false, 
                    error_type: statusCode === 404 ? 'INVALID_TRACKING' : 'API_UNAVAILABLE',
                    message: `DTDC API error: HTTP ${statusCode}. Response: ${responseText.slice(0, 500)}`,
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
                    message: 'Invalid JSON response from DTDC API.',
                    debug_info: debugInfo 
                };
            }
            
            // Handle standard response variations (direct object, wrapped in data or array)
            let consignment = null;
            if (Array.isArray(rawData) && rawData.length > 0) {
                consignment = rawData[0];
            } else if (rawData && rawData.data && Array.isArray(rawData.data) && rawData.data.length > 0) {
                consignment = rawData.data[0];
            } else if (rawData && rawData.events && Array.isArray(rawData.events)) {
                consignment = rawData;
            } else if (rawData && rawData.reference_number) {
                consignment = rawData;
            }

            if (!consignment || !consignment.events || !Array.isArray(consignment.events) || consignment.events.length === 0) {
                return { 
                    success: false, 
                    error_type: 'INVALID_TRACKING',
                    message: 'No shipment tracking events found in DTDC response.',
                    debug_info: debugInfo
                };
            }

            // Parse official DTDC Customer Consignment Tracking events
            const events = consignment.events.map(evt => {
                let formattedTime = '';
                if (evt.event_time) {
                    try {
                        const dateObj = new Date(Number(evt.event_time) || evt.event_time);
                        if (!isNaN(dateObj.getTime())) {
                            formattedTime = dateObj.toLocaleString('en-IN', {
                                day: '2-digit',
                                month: 'short',
                                year: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: true
                            });
                        } else {
                            formattedTime = String(evt.event_time);
                        }
                    } catch (e) {
                        formattedTime = String(evt.event_time);
                    }
                }

                return {
                    customer_update: evt.customer_update || evt.type || 'Update',
                    location: evt.hub_name || evt.hub_code || '',
                    time: formattedTime,
                    raw_time: Number(evt.event_time) || 0
                };
            });

            // Sort newest event first
            events.sort((a, b) => b.raw_time - a.raw_time);

            const timeline = events.map(({ raw_time, ...rest }) => rest);

            return {
                success: true,
                courier_name: 'DTDC',
                tracking_number: consignment.reference_number || trackingNumber,
                status: consignment.status || (timeline[0] ? timeline[0].customer_update : 'In Transit'),
                timeline: timeline,
                debug_info: debugInfo
            };

        } catch (error) {
            console.error('[DTDCTrackingProvider] Network exception querying DTDC API:', error);
            return { 
                success: false, 
                error_type: 'API_UNAVAILABLE',
                message: `Network exception: ${error.message || error}`,
                debug_info: { url: targetUrl || this.apiUrl, method: 'GET', exception: String(error) }
            };
        }
    }
}

class DelhiveryTrackingProvider {
    constructor(env) {
        this.env = env;
    }

    async track(trackingNumber) {
        // Currently implement ONLY DTDC. Delhivery simple store courier name & tracking number.
        // No API integration yet. Architecture allows implementing this track method later without modifying frontend code.
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
