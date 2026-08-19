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
                if (!rawImage && item.product_id && typeof DB !== 'undefined' && typeof DB.getProductById === 'function') {
                    try {
                        const product = await DB.getProductById(item.product_id);
                        if (product && product.image) {
                            rawImage = product.image;
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
    let activeStatus = order.status;
    let statusClass = 'status-' + activeStatus;
    let statusText = activeStatus.charAt(0).toUpperCase() + activeStatus.slice(1);
    
    if (order.payment_status === 'failed' || order.payment_status === 'cancelled') {
        activeStatus = order.payment_status;
        statusClass = 'status-cancelled';
        statusText = 'Payment ' + (activeStatus.charAt(0).toUpperCase() + activeStatus.slice(1));
    } else if (order.status === 'payment_failed') {
        statusClass = 'status-cancelled';
        statusText = 'Payment Failed';
    }

    const date = new Date(order.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

    let headerHtml = `
        <div class="od-header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <div class="od-header-left" style="display: flex; align-items: center; gap: 10px;">
                <a href="index.html?tab=orders" class="btn-back" title="Back to Orders"><i class="fas fa-arrow-left"></i></a>
                <h1 class="od-title" style="margin: 0;">Order Details</h1>
                <span class="order-status ${statusClass}" style="margin-left: 10px;">${statusText}</span>
            </div>
            <button class="btn-primary" id="btn-buy-again" style="padding: 8px 16px; font-size: 0.9rem;" onclick="handleBuyAgain('${order.order_number}')">
                <i class="fas fa-redo" style="margin-right: 6px;"></i> Buy Again
            </button>
        </div>
    `;

    // Attach order data to window so handleBuyAgain can access it
    window._currentOrderData = order;

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

    const itemsHtml     = renderProducts(order.order_items || []);
    const addressHtml   = renderAddress(order.delivery_address);
    const progressHtml  = renderShipmentProgress(order);
    const courierHtml   = renderCourier(order);
    const summaryHtml   = renderSummary(order, date, sub, del, disc);

    // Layout:
    // Full-width: Products
    // Full-width: Shipment Progress
    // Side-by-side (desktop): Delivery Status | Order Summary
    // Full-width: Delivery Address
    // Full-width: Shipment Timeline (injected by tracking button)
    content.innerHTML = `
        ${headerHtml}
        <div class="od-sections">

            <!-- 1. Products Ordered -->
            ${itemsHtml}

            <!-- 2. Shipment Progress -->
            ${progressHtml}

            <!-- 3. Delivery Status + Order Summary side-by-side -->
            <div class="od-row-pair">
                ${courierHtml}
                ${summaryHtml}
            </div>

            <!-- 4. Delivery Address -->
            ${addressHtml}

            <!-- 5. Shipment Timeline (hidden until Track is clicked) -->
            <div id="od-timeline-container" style="display:none;"></div>
        </div>
    `;
    
    const trackBtn = document.getElementById('btn-track-package');
    if (trackBtn) {
        trackBtn.addEventListener('click', () => {
            if (typeof fetchShipmentTracking === 'function') {
                fetchShipmentTracking(order.order_number, order.courier_name, order.tracking_number, trackBtn);
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────
// SHIPMENT PROGRESS TRACKER
// ─────────────────────────────────────────────────────────────
function getShipmentStage(order) {
    const s = (order.status || '').toLowerCase();
    const p = (order.payment_status || '').toLowerCase();
    
    if (p === 'failed' || p === 'cancelled' || s === 'payment_failed' || s === 'cancelled') return -1;
    
    // Delivered
    if (s === 'delivered') return 3;
    // Out for delivery  — check tracking_number text or status
    if (s === 'out_for_delivery' || s === 'out for delivery') return 2;
    // Shipped / in transit
    if (s === 'shipped' || s === 'in_transit' || s === 'in transit') return 1;
    // Everything else: processing / confirmed / pending / payment_failed etc.
    return 0;
}

function renderShipmentProgress(order) {
    const stage = getShipmentStage(order);
    
    if (stage === -1) {
        let msg = 'Payment Failed';
        if (order.status === 'cancelled' || (order.payment_status || '').toLowerCase() === 'cancelled') msg = 'Order Cancelled';
        return `
            <div class="od-card od-progress-card" style="border: 1px solid #FECACA; background: #FEF2F2;">
                <h3 class="od-card-title" style="margin-bottom:10px; color: #DC2626;"><i class="fas fa-times-circle" style="margin-right: 8px;"></i>${msg}</h3>
                <p style="color: #991B1B; font-size: 0.95rem; margin: 0;">This order will not be fulfilled. If you'd like to try again, you can use the Buy Again button above.</p>
            </div>
        `;
    }

    const stages = [
        { label: 'Preparing',        icon: 'fa-box-open' },
        { label: 'Shipped',          icon: 'fa-shipping-fast' },
        { label: 'Out for Delivery', icon: 'fa-truck' },
        { label: 'Delivered',        icon: 'fa-check-circle' },
    ];

    // Colours from existing design system
    const GREEN  = 'var(--primary, #10B981)';
    const ORANGE = '#F59E0B';
    const GRAY   = '#CBD5E1';
    const WHITE  = '#ffffff';

    let stepsHtml = '';
    stages.forEach((st, idx) => {
        const done = idx <= stage;
        const pending = idx > stage;
        const current = idx === stage;

        let circleColor  = done ? GREEN : GRAY;
        let iconColor    = pending ? '#94A3B8' : WHITE;
        let labelColor   = pending ? '#94A3B8' : '#1E293B';
        let labelWeight  = done ? '600' : '400';

        // Connecting line after each step except last
        let lineHtml = '';
        if (idx < stages.length - 1) {
            let lineClasses = 'od-prog-line';
            let lineStyles = '';
            
            if (idx < stage) {
                // Completed line
                lineStyles = `background: ${GREEN};`;
            } else if (idx === stage && stage < 3) {
                // Active progress line to next step
                lineClasses += ' od-prog-line-active';
                lineStyles = `background: ${ORANGE}; box-shadow: 0 0 8px ${ORANGE}4D;`;
            } else {
                // Pending line
                lineStyles = `background: ${GRAY};`;
            }
            
            lineHtml = `<div class="${lineClasses}" style="${lineStyles}">
                ${idx === stage && stage < 3 ? '<div class="od-prog-line-flow"></div>' : ''}
            </div>`;
        }

        stepsHtml += `
            <div class="od-prog-step">
                <div class="od-prog-circle" style="background:${circleColor};">
                    <i class="fas ${st.icon}" style="color:${iconColor}; font-size:0.85rem;"></i>
                </div>
                <div class="od-prog-label" style="color:${labelColor}; font-weight:${labelWeight};">${st.label}</div>
            </div>
            ${lineHtml}
        `;
    });

    return `
        <div class="od-card od-progress-card">
            <h3 class="od-card-title" style="margin-bottom:24px;">Shipment Progress</h3>
            <div class="od-prog-track">
                ${stepsHtml}
            </div>
        </div>
    `;
}


function renderProducts(items) {
    let html = `<div class="od-card"><h3 class="od-card-title">Products Ordered</h3><div>`;
    items.forEach(item => {
        let itemImage = item.resolved_image_url || item.image || item.image_url;
        
        // Show placeholder if no image exists
        if (!itemImage || itemImage.trim() === '') {
            itemImage = 'assets/logo.png';
        }
        
        let imgHtml = `<img src="${itemImage}" alt="${escapeHTML(item.product_name || 'Product')}" class="od-item-img" onerror="this.src='assets/logo.png'">`;
        
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
    let paymentStatus = (order.payment_status || 'Pending');
    paymentStatus = paymentStatus.charAt(0).toUpperCase() + paymentStatus.slice(1);
    
    return `
        <div class="od-card">
            <h3 class="od-card-title">Order Summary</h3>
            <div class="od-summary-row"><span>Order ID</span> <strong>${order.order_number}</strong></div>
            <div class="od-summary-row"><span>Order Date</span> <strong>${date}</strong></div>
            <div class="od-summary-row"><span>Payment Method</span> <strong>${paymentMethod}</strong></div>
            <div class="od-summary-row"><span>Payment Status</span> <strong style="color: ${paymentStatus.toLowerCase() === 'failed' || paymentStatus.toLowerCase() === 'cancelled' ? '#DC2626' : (paymentStatus.toLowerCase() === 'paid' || paymentStatus.toLowerCase() === 'successful' ? '#10B981' : 'inherit')}">${paymentStatus}</strong></div>
            
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
                <div class="od-timeline-scroll">
                    <div style="position: relative; padding-left: 20px; border-left: 2px solid #E2E8F0; margin-left: 10px; padding-bottom: 10px;">
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
        timelineHTML += '</div></div></div>';

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


// ============================================
// BUY AGAIN LOGIC
// ============================================
async function handleBuyAgain(orderNumber) {
    const order = window._currentOrderData;
    if (!order || !order.order_items || order.order_items.length === 0) {
        if (typeof showToast === 'function') showToast('No items found in this order.', 'error');
        return;
    }
    
    const btn = document.getElementById('btn-buy-again');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right: 6px;"></i> Adding...';
    }

    let addedCount = 0;
    let missingCount = 0;
    let outOfStockCount = 0;
    let skippedNames = [];

    for (const item of order.order_items) {
        let product = null;
        if (item.product_id && typeof DB !== 'undefined' && typeof DB.getProductById === 'function') {
            try {
                product = await DB.getProductById(item.product_id);
            } catch (e) {
                console.warn('Product fetch failed', e);
            }
        }
        
        if (!product) {
            missingCount++;
            skippedNames.push(item.product_name || 'An item');
            continue;
        }

        if (product.available === false) {
            outOfStockCount++;
            skippedNames.push(product.name);
            continue;
        }

        let currentPrice = product.price; 
        if (item.weight && product.variants && product.variants.length > 0) {
            const variant = product.variants.find(v => v.weight === item.weight);
            if (variant) {
                currentPrice = variant.price;
            }
        } else if (item.price) {
            currentPrice = item.price; 
        }

        const cartItem = {
            product_id: product.id,
            name: product.name,
            weight: item.weight || '',
            price: currentPrice,
            quantity: item.quantity || 1,
            image: product.image
        };

        if (typeof CartService !== 'undefined') {
            await CartService.addItem(cartItem);
            addedCount++;
        }
    }

    if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-redo" style="margin-right: 6px;"></i> Buy Again';
    }

    if (addedCount > 0) {
        const totalUnavailable = missingCount + outOfStockCount;
        if (totalUnavailable > 0 && typeof showToast === 'function') {
            const namesText = skippedNames.slice(0, 2).join(', ') + (skippedNames.length > 2 ? ' etc.' : '');
            showToast(`Added ${addedCount} item(s). ${namesText} is currently out of stock or unavailable.`, 'warning');
        } else if (typeof showToast === 'function') {
            showToast('Items added to cart successfully!', 'success');
        }
        
        if (typeof CartService !== 'undefined' && typeof CartService.toggleCart === 'function') {
            CartService.toggleCart();
        } else {
            window.location.href = 'checkout.html';
        }
    } else {
        if (typeof showToast === 'function') {
            showToast('All products from this order are currently unavailable or out of stock.', 'error');
        }
    }
}
