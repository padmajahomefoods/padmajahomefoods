// order-details.js
console.log("order-details.js loaded");
console.log(window.location.href);

document.addEventListener('DOMContentLoaded', async () => {
    // Wait for Account module to initialize if necessary
    // Account module usually initializes on DOMContentLoaded in script.js or account.js
    // We will ensure a slight delay to allow auth session to settle if Account isn't fully ready
    setTimeout(initOrderDetails, 100);
});

async function initOrderDetails() {
    try {
        console.log('initOrderDetails started');
        const urlParams = new URLSearchParams(window.location.search);
        const orderId = urlParams.get('orderId');
        console.log('orderId =', orderId);

        const skeleton = document.getElementById('order-details-skeleton');
        const content_el = document.getElementById('order-details-content');

        if (!orderId) {
            showError('Invalid Order ID provided.');
            return;
        }

        let client;
        if (typeof window.getSupabaseClient === 'function') {
            client = await window.getSupabaseClient();
        } else if (window.supabase) {
            client = window.supabase;
        }

        if (!client) {
            console.error('Supabase client not loaded');
            showError('System error. Please try again later.');
            return;
        }
        console.log('Supabase initialized');

        if (typeof Account !== 'undefined' && typeof Account.checkSession === 'function') {
             await Account.checkSession();
        }
        
        let user = null;
        let session = null;
        if (typeof Account !== 'undefined' && Account.getCurrentUser) {
            user = await Account.getCurrentUser();
        }
        
        // Also grab session to log
        const { data: sessionData, error: sessionErr } = await client.auth.getSession();
        session = sessionData?.session || null;
        console.log('Current session =', session);
        
        if (!user) {
            console.error('User not logged in');
            showError('Please log in to view order details.');
            return;
        }

        console.log('Fetching order...');
        
        const ordersTable = (typeof CONFIG !== 'undefined' && CONFIG.TABLES && CONFIG.TABLES.ORDERS) ? CONFIG.TABLES.ORDERS : 'orders';
        const itemsTable = (typeof CONFIG !== 'undefined' && CONFIG.TABLES && CONFIG.TABLES.ORDER_ITEMS) ? CONFIG.TABLES.ORDER_ITEMS : 'order_items';
        
        const { data, error } = await client
            .from(ordersTable)
            .select('*')
            .eq('order_number', orderId)
            .single();

        console.log('Query result =', data);
        if (error) console.log('Supabase error =', error);

        if (error) {
            console.error('Supabase query error (orders):', error);
            showError('Order Not Found');
            return;
        }

        if (!data) {
            console.error('No order returned from query');
            showError('Order Not Found');
            return;
        }

        const { data: items, error: itemsErr } = await client
            .from(itemsTable)
            .select('*')
            .eq('order_id', data.id);
            
        
        if (itemsErr) {
            console.warn('Error fetching order items:', itemsErr);
            data.order_items = [];
        } else {
            // Resolve missing images dynamically using product_id
            const resolvedItems = [];
            for (const item of (items || [])) {
                let rawImage = item.image || item.image_url;
                if (!rawImage && item.product_id) {
                    try {
                        const { data: prodData } = await client
                            .from(typeof CONFIG !== 'undefined' && CONFIG.TABLES && CONFIG.TABLES.PRODUCTS ? CONFIG.TABLES.PRODUCTS : 'products')
                            .select('image')
                            .eq('id', item.product_id)
                            .single();
                        if (prodData && prodData.image) {
                            rawImage = prodData.image;
                        }
                    } catch(e) {
                        console.warn('Could not fetch product image for item', item.id);
                    }
                }
                
                if (rawImage) {
                    item.resolved_image_url = typeof DB !== 'undefined' && typeof DB.getImageUrl === 'function' ? DB.getImageUrl(rawImage) : rawImage;
                }
                resolvedItems.push(item);
            }
            data.order_items = resolvedItems;
        }

        renderOrderPage(data);
        
        if (skeleton) skeleton.style.display = 'none';
        if (content_el) content_el.style.display = 'block';

    } catch (err) {
        console.error('FATAL ERROR in initOrderDetails:', err.stack || err);
        showError('Unable to load order details. Check console for details.');
    }
}
function showError(msg) {
    const skeleton = document.getElementById('order-details-skeleton');
    if (skeleton) {
        skeleton.style.display = 'block'; // Ensure visible
        skeleton.innerHTML = `
            <div style="text-align: center; padding: 60px 20px;">
                <i class="fas fa-exclamation-circle fa-3x" style="color: var(--spice-red, #dc2626); margin-bottom: 20px;"></i>
                <h3 style="font-family: var(--font-heading); color: var(--text-dark); margin-bottom: 10px;">${escapeHTML(msg)}</h3>
                <a href="index.html?tab=orders" class="btn-primary" style="display: inline-block; margin-top: 20px;">Return to My Orders</a>
            </div>
        `;
    }
    const content_el = document.getElementById('order-details-content');
    if (content_el) {
        content_el.style.display = 'none';
    }
}


function renderOrderPage(order) {
    const content = document.getElementById('order-details-content');
    
    // Top Section
    const statusClass = 'status-' + order.status;
    const statusText = order.status.charAt(0).toUpperCase() + order.status.slice(1);
    const date = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    let headerHtml = `
        <div class="od-header">
            <div class="od-header-left">
                <a href="index.html?tab=orders" class="btn-back" title="Back to Orders"><i class="fas fa-arrow-left"></i></a>
                <h1 class="od-title">Order Details</h1>
            </div>
            <span class="order-status ${statusClass}">${statusText}</span>
        </div>
    `;

    // Extract financials
    let sub = order.subtotal || order.total_amount;
    let del = order.delivery_charge || 0;
    let disc = order.delivery_discount || 0;
    if (order.notes && typeof order.notes === 'string' && order.notes.includes('Subtotal:')) {
        const parts = order.notes.split('|').map(s => s.trim());
        parts.forEach(p => {
            if (p.startsWith('Subtotal:')) sub = parseFloat(p.replace('Subtotal:', '').trim()) || sub;
            if (p.startsWith('Delivery:')) del = parseFloat(p.replace('Delivery:', '').trim()) || del;
            if (p.startsWith('Discount:')) disc = parseFloat(p.replace('Discount:', '').trim()) || disc;
        });
    }

    const itemsHtml = renderProducts(order.order_items || []);
    const courierHtml = renderCourier(order);
    const summaryHtml = renderSummary(order, date, sub, del, disc);
    const addressHtml = renderAddress(order.delivery_address);

    content.innerHTML = `
        ${headerHtml}
        <div class="od-grid">
            <!-- Left Column: Products, Address, Timeline -->
            <div class="od-col-left">
                ${itemsHtml}
                <!-- Mobile only: Courier and Summary shown here between Products and Address -->
                <div class="od-mobile-only" style="display:none;"></div>
                ${addressHtml}
                <div id="od-timeline-container" style="display:none;"></div>
            </div>
            
            <!-- Right Column: Courier, Summary -->
            <div class="od-col-right">
                ${courierHtml}
                ${summaryHtml}
            </div>
        </div>
    `;
    
    // For mobile stacking requirement, we use CSS flex column order or just JS insertion
    if (window.innerWidth < 768) {
        const rightCol = document.querySelector('.od-col-right');
        const leftCol = document.querySelector('.od-col-left');
        const addressEl = leftCol.querySelectorAll('.od-card')[1]; // Address is 2nd card in left
        // Move Courier & Summary before address
        leftCol.insertBefore(rightCol.children[0], addressEl); // Courier
        leftCol.insertBefore(rightCol.children[0], addressEl); // Summary
        rightCol.style.display = 'none'; // Hide right col completely
    }
    
    const trackBtn = document.getElementById('btn-track-package');
    if (trackBtn) {
        trackBtn.addEventListener('click', () => {
            if (typeof fetchShipmentTracking === 'function') {
                fetchShipmentTracking(order.order_number, order.courier_name, order.tracking_number, trackBtn);
            }
        });
    }
}
function renderProducts(items) {
    let html = `<div class="od-card"><h3 class="od-card-title">Products Ordered</h3><div>`;
    items.forEach(item => {
        let itemImage = item.resolved_image_url || item.image || item.image_url;
        let imgHtml = '';
        if (itemImage && itemImage.trim() !== '' && itemImage !== 'assets/logo.png') {
            imgHtml = `<img src="${itemImage}" alt="${escapeHTML(item.product_name || 'Product')}" class="od-item-img" onerror="this.style.display='none'">`;
        }
        
        let safeName = escapeHTML(item.product_name || 'Product');
        let safeWeight = item.weight ? '| ' + escapeHTML(item.weight) : '';
        
        html += `
            <div class="od-item">
                ${imgHtml}
                <div class="od-item-info">
                    <div class="od-item-name">${safeName}</div>
                    <div class="od-item-meta">Qty: ${item.quantity} ${safeWeight}</div>
                    <div class="od-item-price">&#8377;${Number(item.total).toLocaleString('en-IN')}</div>
                </div>
            </div>
        `;
    });
    html += `</div></div>`;
    return html;
}
function renderCourier(order) {
    if (order.status !== 'shipped' && order.status !== 'delivered' && !(order.tracking_number && order.tracking_number.trim() !== '')) {
        return '';
    }
    
    let cName = order.courier_name || 'DTDC';
    let tNum = order.tracking_number || 'N/A';
    
    return `
        <div class="od-card">
            <h3 class="od-card-title">Delivery Status</h3>
            <div style="margin-bottom: 16px; font-size: 0.95rem; color: var(--text-dark);">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <span style="color: var(--text-gray);">Courier</span>
                    <strong>${cName}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-gray);">Tracking #</span>
                    <strong>${tNum}</strong>
                </div>
            </div>
            ${order.tracking_number ? `
                <button type="button" id="btn-track-package" class="btn-primary" style="width: 100%;"><i class="fas fa-shipping-fast" style="margin-right: 8px;"></i>Track Package</button>
            ` : ''}
        </div>
    `;
}
function renderSummary(order, date, sub, del, disc) {
    const paymentMethod = (order.payment_method || 'Online').toUpperCase();
    return `
        <div class="od-card">
            <h3 class="od-card-title">Order Summary</h3>
            <div class="od-summary-row"><span>Order ID</span> <strong>${order.order_number}</strong></div>
            <div class="od-summary-row"><span>Order Date</span> <strong>${date}</strong></div>
            <div class="od-summary-row"><span>Payment</span> <strong>${paymentMethod}</strong></div>
            
            <hr class="od-divider">
            
            <div class="od-summary-row"><span>Subtotal</span> <strong>&#8377;${Number(sub).toLocaleString('en-IN')}</strong></div>
            <div class="od-summary-row"><span>Delivery</span> <strong>${Number(del) === 0 ? 'Free' : '&#8377;' + Number(del).toLocaleString('en-IN')}</strong></div>
            ${Number(disc) > 0 ? `<div class="od-summary-row" style="color: #48BB78;"><span>Discount</span> <strong>-&#8377;${Number(disc).toLocaleString('en-IN')}</strong></div>` : ''}
            
            <hr class="od-divider">
            
            <div class="od-summary-row od-total-row"><span>Grand Total</span> <strong>&#8377;${Number(order.total_amount).toLocaleString('en-IN')}</strong></div>
        </div>
    `;
}

function renderAddress(address) {
    if (!address) return '';
    let obj;
    if (typeof address === 'string') {
        if (address.trim().startsWith('{')) {
            try { obj = JSON.parse(address); } catch(e) { return `<div class="od-card"><h3 class="od-card-title">Delivery Address</h3><div class="od-address-text">${escapeHTML(address)}</div></div>`; }
        } else {
            return `<div class="od-card"><h3 class="od-card-title">Delivery Address</h3><div class="od-address-text">${escapeHTML(address)}</div></div>`;
        }
    } else {
        obj = address;
    }
    
    const lines = [];
    if (obj.full_name) lines.push(`<strong>${escapeHTML(obj.full_name)}</strong>`);
    if (obj.phone) lines.push(escapeHTML(obj.phone));
    if (obj.email) lines.push(escapeHTML(obj.email));
    if (obj.address_line1) lines.push(escapeHTML(obj.address_line1));
    if (obj.address_line2) lines.push(escapeHTML(obj.address_line2));
    
    const csp = [];
    if (obj.city) csp.push(obj.city);
    if (obj.state) csp.push(obj.state);
    let cspStr = csp.join(', ');
    if (obj.pincode) cspStr += (cspStr ? ' - ' : '') + obj.pincode;
    if (cspStr) lines.push(cspStr);
    
    let htmlStr = lines.length === 0 ? (obj.full_address ? escapeHTML(obj.full_address) : escapeHTML(JSON.stringify(obj))) : lines.join('<br>');
    
    return `<div class="od-card"><h3 class="od-card-title">Delivery Address</h3><div class="od-address-text">${htmlStr}</div></div>`;
}

let isTracking = false;
async function fetchShipmentTracking(orderNumber, courierName, trackingNumber, btnEl) {
    if (isTracking) return;
    
    const container = document.getElementById('od-timeline-container');
    container.style.display = 'block';
    
    isTracking = true;
    const originalBtnText = btnEl.innerHTML;
    btnEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> <span>Tracking...</span>';
    btnEl.style.opacity = '0.7';
    btnEl.style.cursor = 'not-allowed';

    container.innerHTML = `
        <div class="od-card" style="border: 2px solid var(--primary);">
            <h3 class="od-card-title">Shipment Timeline</h3>
            <div style="text-align: center; padding: 20px; color: var(--text-gray);">
                <i class="fas fa-spinner fa-spin fa-2x"></i>
                <p style="margin-top: 10px;">Connecting to courier...</p>
            </div>
        </div>
    `;

    try {
        const response = await fetch('/api/track-shipment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ courier_name: courierName, tracking_number: trackingNumber })
        });

        const data = await response.json().catch(() => ({ success: false }));

        if (!response.ok || !data.success) {
            let errorMsg = "Unable to fetch latest tracking updates. Please try again later.";
            if (data && data.error_type === 'INVALID_TRACKING') {
                errorMsg = data.message || "Tracking information is currently unavailable or invalid.";
            }
            container.innerHTML = `
                <div class="od-card">
                    <h3 class="od-card-title">Shipment Timeline</h3>
                    <div style="padding: 16px; background: #FFFBEB; border-left: 4px solid #F59E0B; border-radius: 4px; color: #92400E;">
                        <i class="fas fa-exclamation-triangle" style="margin-right: 8px;"></i> ${escapeHTML(errorMsg)}
                    </div>
                </div>
            `;
            return;
        }

        const events = data.timeline || [];
        if (events.length === 0) {
            container.innerHTML = `
                <div class="od-card">
                    <h3 class="od-card-title">Shipment Timeline</h3>
                    <div style="padding: 16px; background: #F8FAFC; border-radius: 4px; color: #475569; text-align: center;">
                        No tracking events reported yet. Please check back shortly.
                    </div>
                </div>
            `;
            return;
        }

        let timelineHTML = `
            <div class="od-card" style="border: 1px solid var(--primary);">
                <h3 class="od-card-title" style="margin-bottom: 24px;">Shipment Timeline</h3>
                <div style="position: relative; padding-left: 20px; border-left: 2px solid #E2E8F0; margin-left: 10px;">
        `;
        
        events.forEach((evt, idx) => {
            const isLatest = idx === 0;
            const dotColor = isLatest ? 'var(--primary, #10B981)' : '#94A3B8';
            const textColor = isLatest ? 'var(--text-dark, #1E293B)' : '#475569';
            const fontWeight = isLatest ? '700' : '500';
            
            timelineHTML += `
                <div style="position: relative; margin-bottom: ${idx === events.length - 1 ? '0' : '24px'};">
                    <div style="position: absolute; left: -27px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: ${dotColor}; border: 3px solid white; box-shadow: 0 0 0 2px ${dotColor};"></div>
                    <div style="font-weight: ${fontWeight}; color: ${textColor}; font-size: 1rem; line-height: 1.4;">
                        ${escapeHTML(evt.customer_update || evt.status || 'Update')}
                    </div>
                    <div style="font-size: 0.85rem; color: #64748B; margin-top: 4px; display: flex; flex-direction: column; gap: 4px;">
                        ${evt.location ? `<span><i class="fas fa-map-marker-alt" style="width: 14px; text-align: center; margin-right: 6px;"></i>${escapeHTML(evt.location)}</span>` : ''}
                        ${evt.time ? `<span><i class="far fa-clock" style="width: 14px; text-align: center; margin-right: 6px;"></i>${escapeHTML(evt.time)}</span>` : ''}
                    </div>
                </div>
            `;
        });
        timelineHTML += '</div></div>';

        container.innerHTML = timelineHTML;

    } catch (err) {
        console.error('Error tracking shipment:', err);
        container.innerHTML = `
            <div class="od-card">
                <h3 class="od-card-title">Shipment Timeline</h3>
                <div style="padding: 16px; background: #FFFBEB; border-left: 4px solid #F59E0B; border-radius: 4px; color: #92400E;">
                    <i class="fas fa-wifi" style="margin-right: 8px;"></i> Network error while fetching updates.
                </div>
            </div>
        `;
    } finally {
        isTracking = false;
        btnEl.innerHTML = originalBtnText;
        btnEl.style.opacity = '1';
        btnEl.style.cursor = 'pointer';
        
        // Scroll to timeline on mobile if needed
        if (window.innerWidth < 768) {
            container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
}
