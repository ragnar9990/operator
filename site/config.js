/* Operator site — the one file to fill in before launch.
   Everything the checkout and the legal pages need lives here, so nothing is
   hard-coded across a dozen files. Until the placeholders below are replaced,
   the site behaves exactly as it did: the Buy button explains checkout is not
   open yet, and the legal pages show the placeholders plainly.

   How to fill it:
   - Paddle: sign in at vendors.paddle.com → Paddle Billing.
       token   — Developer Tools → Authentication → "Client-side tokens"
                 (starts "live_" for production, "test_" for sandbox).
       priceId — Catalog → Products → your $49 price (starts "pri_").
       environment — "sandbox" while testing, "production" when live.
     Paddle is the merchant of record: it takes the payment, charges the right
     sales tax/VAT, sends the receipt and handles the refund. That is why the
     refund and tax wording on the legal pages points at Paddle.
   - supportEmail — the address a human checks daily. Refund and support links
     use it.
   - seller — the legal name that sells Operator (a person or a company), and
     the country whose law the terms fall under.
   - domain — the site's own address, e.g. https://operator.example. Used for
     canonical links on the legal pages. */

window.OPERATOR_SITE = {
  paddle: {
    token: 'PADDLE_CLIENT_TOKEN',   // e.g. 'live_abc123...' — replace to turn checkout on
    priceId: 'PADDLE_PRICE_ID',     // e.g. 'pri_01h...'
    environment: 'sandbox',         // 'sandbox' while testing, then 'production'
  },
  supportEmail: 'SUPPORT_EMAIL',    // e.g. 'support@operator.example'
  seller: {
    name: 'SELLER_NAME',            // the person or company that sells Operator
    country: 'Australia',           // the law the Terms fall under
  },
  domain: 'SITE_DOMAIN',            // e.g. 'https://operator.example'
};

// True once a value has actually been filled in (not still a placeholder).
window.OPERATOR_SITE.set = (v) =>
  typeof v === 'string' && v && !/^(PADDLE_|SUPPORT_EMAIL$|SELLER_NAME$|SITE_DOMAIN$)/.test(v);
