function canAccess(req, permission) {
    if (!req.user)
        return false;
    const isAdmin = typeof req.user.role === 'number' && req.user.role <= 1;
    if (isAdmin)
        return true;
    return Array.isArray(req.permissions) && req.permissions.includes(permission);
}
module.exports = { canAccess };
