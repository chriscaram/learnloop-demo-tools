// What LearnLoop writes for each request the history uses beyond the original routes:
// the service, the route template, and the business events logged while handling it,
// in order (each event line precedes the request line, with the same trace and
// request id). test/contract.test.js runs the real LearnLoop handlers and checks
// every row, so the generator cannot drift from the code.
export const ACTIONS = Object.freeze({
  cartRead: { service: 'catalog', method: 'GET', route: '/api/me/cart', events: [] },
  cartAdd: { service: 'catalog', method: 'POST', route: '/api/me/cart/items', events: [{ event: 'cart_item_added', entityType: 'course', actorType: 'learner' }] },
  cartRemove: { service: 'catalog', method: 'DELETE', route: '/api/me/cart/items/{courseId}', events: [{ event: 'cart_item_removed', entityType: 'course', actorType: 'learner' }] },
  // enrolling also takes the course out of the cart, without an event of its own
  enrol: { service: 'catalog', method: 'POST', route: '/api/courses/{courseId}/enrol', events: [{ event: 'course_enrolled', entityType: 'course', actorType: 'learner' }] },
  supportList: { service: 'notifications', method: 'GET', route: '/api/me/support-requests', events: [] },
  supportAsk: { service: 'notifications', method: 'POST', route: '/api/me/support-requests', events: [{ event: 'support_request_created', entityType: 'support_request', actorType: 'learner' }] },
  supportQueue: { service: 'admin', method: 'GET', route: '/api/admin/support-requests', events: [] },
  supportReply: {
    service: 'admin',
    method: 'POST',
    route: '/api/admin/support-requests/{requestId}/reply',
    events: [
      { event: 'notification_created', entityType: 'notification', actorType: 'system' },
      { event: 'support_reply_sent', entityType: 'support_request', actorType: 'staff' },
    ],
  },
});

/** The inbox notification a reply creates. */
export const SUPPORT_REPLY_NOTIFICATION = Object.freeze({
  type: 'support_reply',
  title: 'The LearnLoop team replied to your question',
  link: '/help',
});
