// order-details.js

document.addEventListener('DOMContentLoaded', async () => {
    // Wait for Account module to initialize if necessary
    // Account module usually initializes on DOMContentLoaded in script.js or account.js
    // We will ensure a slight delay to allow auth session to settle if Account isn't fully ready
    setTimeout(initOrderDetails, 100);
});

async function initOrderDetails() {
    const urlParams = new URLSearchParams(window.location.search);
    const orderId = urlParams.get('orderId');

    const skeleton = document.getElementById('order-details-skeleton');
    const content = document.getElementById('order-details-content');

    if (!orderId) {
        showError("Invalid Order ID provided.");
        return;
    }

    try {
        // We will fetch the specific order from Supabase
        // Note: Account.js uses supabaseClient which is exposed globally via db.js (supabase)
        if (!window.supabase) {
            console.error("Supabase client not loaded");
            showError("System error. Please try again later.");
            return;
        }

        const { data: order, error } = await window.supabase
            .from('orders')
            .select('*, order_items(*)')
            .eq('order_number', orderId)
            .single();

        if (error || !order) {
            console.error(error);
            showError("Order Not Found");
            return;
        }

        // Verify that the logged-in user owns this order
        // if Account._currentUser is available, check it. (Sometimes they might not be fully loaded, we rely on RLS anyway)
        
        renderOrderPage(order);
        
        skeleton.style.display = 'none';
        content.style.display = 'block';

    } catch (err) {
        console.error("Error fetching order:", err);
        showError("Unable to load order details at this time.");
    }
}

function showError(msg) {
    const skeleton = document.getElementById('order-details-skeleton');
    skeleton.innerHTML = `
        <div style="text-align: center; padding: 60px 20px;">
            <i class="fas fa-exclamation-circle fa-3x" style="color: var(--spice-red, #dc2626); margin-bottom: 20px;"></i>
            <h3 style="font-family: var(--font-heading); color: var(--text-dark); margin-bottom: 10px;">${escapeHTML(msg)}</h3>
            <a href="index.html?tab=orders" class="btn-primary" style="display: inline-block; margin-top: 20px;">Return to My Orders</a>
        </div>
    `;
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

function renderOrderPage(order) {
    const content = document.getElementById('order-details-content');
    
    // Top Section
    const statusClass = 'status-' + order.status;
    const statusText = order.status.charAt(0).toUpperCase() + order.status.slice(1);
    const date = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    let headerHtml = `
        <div class="od-header">
            <a href="index.html?tab=orders" class="btn-back" title="Back to Orders"><i class="fas fa-arrow-left"></i></a>
            <h1 class="od-title">Order Details</h1>
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
            <div class="od-col-left">
                ${itemsHtml}
                ${addressHtml}
                <div id="od-timeline-container" style="display:none;"></div>
            </div>
            <div class="od-col-right">
                ${courierHtml}
                ${summaryHtml}
                
                <div class="od-actions-card">
                    <h3 class="od-card-title">Order Actions</h3>
                    <div style="display: flex; flex-direction: column; gap: 10px;">
                        <button class="btn-secondary" onclick="alert('Feature coming soon!')"><i class="fas fa-file-invoice"></i> Download Invoice</button>
                        <button class="btn-secondary" onclick="alert('Feature coming soon!')"><i class="fas fa-sync"></i> Reorder Items</button>
                        ${order.status === 'pending' || order.status === 'processing' ? `<button class="btn-secondary" style="color: var(--spice-red); border-color: #fca5a5;" onclick="alert('Feature coming soon!')"><i class="fas fa-times"></i> Cancel Order</button>` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Attach Tracking Event Listener
    const trackBtn = document.getElementById('btn-track-package');
    if (trackBtn) {
        trackBtn.addEventListener('click', () => {
            fetchShipmentTracking(order.order_number, order.courier_name, order.tracking_number, trackBtn);
        });
    }
}

function renderProducts(items) {
    let html = `<div class="od-card"><h3 class="od-card-title">Products Ordered</h3><div class="od-items-list">`;
    items.forEach(item => {
        let itemImage = item.image || item.image_url || 'assets/logo.png';
        html += `
            <div class="od-item">
                <img src="${itemImage}" alt="${escapeHTML(item.product_name)}" class="od-item-img" onerror="this.src='assets/logo.png'">
                <div class="od-item-info">
                    <div class="od-item-name">${escapeHTML(item.product_name)}</div>
                    <div class="od-item-meta">${escapeHTML(item.weight)} &times; ${item.quantity}</div>
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
    
    return `
        <div class="od-card">
            <h3 class="od-card-title">Delivery Status</h3>
            <div style="margin-bottom: 16px; font-size: 0.95rem; color: var(--text-dark);">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                    <span style="color: var(--text-gray);">Courier</span>
                    <strong>${escapeHTML(order.courier_name || 'DTDC')}</strong>
                </div>
                <div style="display: flex; justify-content: space-between;">
                    <span style="color: var(--text-gray);">Tracking #</span>
                    <strong>${escapeHTML(order.tracking_number || 'N/A')}</strong>
                </div>
            </div>
            ${order.tracking_number ? `
                <button type="button" id="btn-track-package" class="btn-primary" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;">
                    <i class="fas fa-shipping-fast"></i> <span>Track Package</span>
                </button>
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
