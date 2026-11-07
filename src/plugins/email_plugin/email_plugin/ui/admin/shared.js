(function () {
    const PLUGIN_ID = 'email_plugin';
    const API_BASE = '/api/plugins/' + PLUGIN_ID;
    function escapeHtml(value) {
        const el = document.createElement('div');
        el.textContent = String(value || '');
        return el.innerHTML;
    }
    async function api(path, options) {
        const response = await fetch(API_BASE + path, {
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...(options && options.headers ? options.headers : {}),
            },
            ...options,
        });
        let data = null;
        try {
            data = await response.json();
        }
        catch {
            data = null;
        }
        if (!response.ok) {
            throw new Error((data && data.message) || 'Request failed (' + response.status + ')');
        }
        return data;
    }
    function formatDate(value) {
        if (!value)
            return '—';
        try {
            return new Date(value).toLocaleString();
        }
        catch {
            return String(value);
        }
    }
    window.EmailPlugin = {
        PLUGIN_ID,
        API_BASE,
        api,
        escapeHtml,
        formatDate,
    };
})();
