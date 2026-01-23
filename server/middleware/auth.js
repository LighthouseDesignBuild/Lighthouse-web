/**
 * Authentication Middleware
 * Handles session validation and role-based access control
 */

/**
 * Check if user is authenticated
 */
export function isAuthenticated(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Please log in to access this resource'
  });
}

/**
 * Check if user is admin
 */
export function isAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Please log in to access this resource'
    });
  }

  if (req.session.userRole !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required'
    });
  }

  return next();
}

/**
 * Check if user is editor or admin (for gallery management)
 */
export function isEditor(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Please log in to access this resource'
    });
  }

  if (!['admin', 'editor'].includes(req.session.userRole)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Editor access required'
    });
  }

  return next();
}

/**
 * Optional auth - adds user info to request if logged in
 */
export function optionalAuth(req, res, next) {
  // Just continue - session info will be available if logged in
  return next();
}

/**
 * Check if user needs to change password (disabled - kept for backwards compatibility)
 */
export function checkPasswordChange(req, res, next) {
  return next();
}

export default {
  isAuthenticated,
  isAdmin,
  isEditor,
  optionalAuth,
  checkPasswordChange
};
