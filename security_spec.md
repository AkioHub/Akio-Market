# Security Specification for Akio Market

## 1. Data Invariants
- A product must have a name, price (positive), and stock (non-negative).
- Settings must have a `flashSaleStartTime` that is a valid timestamp string.
- Users cannot change their own `role` or `isVIP` status (only through "Upgrade" action which might have specific rules or admin intervention).
- Orders must belong to a valid user.

## 2. Dirty Dozen Payloads
- P1: Create a product with price: -100 (Negative Price)
- P2: Update global settings as a guest (Unauthorized Write)
- P3: Read other users' orders (Privacy Breach)
- P4: Self-assign `role: 'admin'` (Privilege Escalation)
- P5: Set `isVIP: true` without payment/validation (Gratuitous Upgrade)
- P6: Create a product with a 2MB image string (Resource Exhaustion)
- P7: Update a product's name to a 10KB string (Resource Exhaustion)
- P8: Delete a product as a regular user (Unauthorized Deletion)
- P9: Access `users` collection without being logged in (Data Leak)
- P10: Inject script into product description/name (XSS)
- P11: Create an order for a different user (Identity Spoofing)
- P12: Overwrite a product's ID with special characters (ID Poisoning)

## 3. Test Cases (Mental check, rules will enforce)
- `users`: Only allow read/write if `request.auth.uid == userId`. Since we use manual users, we'll use a `users` collection where `docId` is username.
- `products`: Anyone can list/get. Only admins can write.
- `settings`: Anyone can read. Only admins can write.
- `orders`: Users can only read/write their own orders.
