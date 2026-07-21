// Default settings to fall back to if DB is empty or reset is clicked
const DEFAULT_DELIVERY_SETTINGS = {
    FREE_DELIVERY_THRESHOLD: 1999,
    WEIGHT_SLABS: [
        { maxWeight: 500, charge: 59 },
        { maxWeight: 1000, charge: 89 },
        { maxWeight: 2000, charge: 129 },
        { maxWeight: 3000, charge: 169 }
    ],
    MAX_SLAB_CHARGE: 249
};

let currentSlabs = [];

document.addEventListener('DOMContentLoaded', async () => {
    // Rely on admin.js to redirect if not authenticated
    // We just show the content and initialize
    document.getElementById('adminContent').classList.add('active');
    await initSettings();
});

async function initSettings() {
    if (typeof SettingsService !== 'undefined' && SettingsService.loadSettings) {
        await SettingsService.loadSettings();
    }
    
    // Load into UI
    const threshold = CONFIG.DELIVERY ? CONFIG.DELIVERY.FREE_DELIVERY_THRESHOLD : DEFAULT_DELIVERY_SETTINGS.FREE_DELIVERY_THRESHOLD;
    document.getElementById('freeDeliveryThreshold').value = threshold;
    
    currentSlabs = [];
    const slabsToLoad = (CONFIG.DELIVERY && CONFIG.DELIVERY.WEIGHT_SLABS) ? CONFIG.DELIVERY.WEIGHT_SLABS : DEFAULT_DELIVERY_SETTINGS.WEIGHT_SLABS;
    
    slabsToLoad.forEach(slab => {
        currentSlabs.push({ ...slab });
    });
    
    renderSlabs();
}

function renderSlabs() {
    const container = document.getElementById('weightSlabsContainer');
    
    if (currentSlabs.length === 0) {
        container.innerHTML = '<p style="color: var(--text-gray); font-size: 0.9rem;">No weight slabs defined. Orders will use the fallback charge.</p>';
        return;
    }
    
    // Sort slabs by maxWeight for display
    currentSlabs.sort((a, b) => a.maxWeight - b.maxWeight);
    
    let html = `
        <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 15px; margin-bottom: 8px; padding: 0 15px;">
            <label style="font-size: 0.85rem; color: var(--text-gray); font-weight: 500;">Up to Weight (grams)</label>
            <label style="font-size: 0.85rem; color: var(--text-gray); font-weight: 500;">Delivery Charge (₹)</label>
            <div></div>
        </div>
    `;
    
    currentSlabs.forEach((slab, index) => {
        html += `
            <div class="slab-row">
                <input type="number" min="0" value="${slab.maxWeight}" onchange="updateSlab(${index}, 'maxWeight', this.value)" placeholder="e.g. 500">
                <input type="number" min="0" value="${slab.charge}" onchange="updateSlab(${index}, 'charge', this.value)" placeholder="e.g. 59">
                <button type="button" class="btn-remove-slab" onclick="removeWeightSlab(${index})" title="Remove Slab"><i class="fas fa-trash"></i></button>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function updateSlab(index, field, value) {
    const val = parseInt(value) || 0;
    if (val < 0) {
        showToast('Values cannot be negative', 'error');
        renderSlabs();
        return;
    }
    currentSlabs[index][field] = val;
}

function addWeightSlab() {
    // Find the current highest maxWeight to suggest the next one
    let nextMax = 500;
    if (currentSlabs.length > 0) {
        const highest = Math.max(...currentSlabs.map(s => s.maxWeight));
        nextMax = highest + 1000;
    }
    
    currentSlabs.push({ maxWeight: nextMax, charge: 0 });
    renderSlabs();
}

function removeWeightSlab(index) {
    currentSlabs.splice(index, 1);
    renderSlabs();
}

function resetShippingSettings() {
    if (!confirm('Are you sure you want to reset to the default settings? This will not save until you click "Save Settings".')) {
        return;
    }
    
    document.getElementById('freeDeliveryThreshold').value = DEFAULT_DELIVERY_SETTINGS.FREE_DELIVERY_THRESHOLD;
    currentSlabs = [];
    DEFAULT_DELIVERY_SETTINGS.WEIGHT_SLABS.forEach(slab => {
        currentSlabs.push({ ...slab });
    });
    
    renderSlabs();
    showToast('Reset to defaults. Click Save Settings to apply.', 'success');
}

async function saveShippingSettings() {
    const btn = document.getElementById('saveSettingsBtn');
    
    // Validation
    const thresholdInput = document.getElementById('freeDeliveryThreshold').value;
    const threshold = parseInt(thresholdInput);
    
    if (isNaN(threshold) || threshold < 0) {
        showToast('Invalid Free Delivery Threshold', 'error');
        return;
    }
    
    // Validate slabs
    const seenWeights = new Set();
    let hasError = false;
    
    for (let i = 0; i < currentSlabs.length; i++) {
        const slab = currentSlabs[i];
        if (slab.maxWeight <= 0) {
            showToast('Weight limit must be greater than 0', 'error');
            hasError = true;
            break;
        }
        if (slab.charge < 0) {
            showToast('Charge cannot be negative', 'error');
            hasError = true;
            break;
        }
        if (seenWeights.has(slab.maxWeight)) {
            showToast(`Duplicate weight slab found: ${slab.maxWeight}g`, 'error');
            hasError = true;
            break;
        }
        seenWeights.add(slab.maxWeight);
    }
    
    if (hasError) return;
    
    // Sort before saving
    currentSlabs.sort((a, b) => a.maxWeight - b.maxWeight);
    renderSlabs(); // Update UI with sorted order
    
    // Determine max_slab_charge fallback (usually higher than highest slab, but we'll default to 249 or config default)
    let maxCharge = DEFAULT_DELIVERY_SETTINGS.MAX_SLAB_CHARGE;
    if (currentSlabs.length > 0) {
        const highestCharge = currentSlabs[currentSlabs.length - 1].charge;
        maxCharge = Math.max(highestCharge + 50, DEFAULT_DELIVERY_SETTINGS.MAX_SLAB_CHARGE);
    }
    
    const payload = {
        free_delivery_threshold: threshold,
        weight_slabs: currentSlabs,
        max_slab_charge: maxCharge
    };
    
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    btn.disabled = true;
    
    try {
        const res = await SettingsService.updateSetting('delivery', payload);
        if (res.success) {
            showToast('Shipping settings updated successfully', 'success');
            // Update in-memory config so current session reflects it
            if (typeof CONFIG !== 'undefined' && CONFIG.DELIVERY) {
                CONFIG.DELIVERY.FREE_DELIVERY_THRESHOLD = threshold;
                CONFIG.DELIVERY.WEIGHT_SLABS = currentSlabs;
                CONFIG.DELIVERY.MAX_SLAB_CHARGE = maxCharge;
            }
        } else {
            showToast('Error: ' + res.message, 'error');
        }
    } catch (err) {
        console.error('Save failed:', err);
        showToast('Failed to save settings. Please try again.', 'error');
    } finally {
        btn.innerHTML = 'Save Settings';
        btn.disabled = false;
    }
}

// Toast Notification Helper
function showToast(msg, type = 'info') {
    const c = document.getElementById('adminToastContainer');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'admin-toast ' + type;
    const i = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
    t.innerHTML = '<i class="fas ' + i + '"></i> <span>' + msg + '</span>';
    c.appendChild(t);
    setTimeout(() => t.remove(), 3000);
}
