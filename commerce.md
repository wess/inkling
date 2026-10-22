# Ecommerce and Square

Inkling manages the pages shoppers see. Square manages the products, variations,
prices, stock, payments, and orders. Shoppers build a cart on your website and
finish paying on Square's checkout page.

## For the shop owner

Ask your website manager to enable **Square** and connect the shop to your website.
Square also enables **Ecommerce**. The existing plugin identifier is still `commerce`.

1. Open **More tools → Square → Setup** and press **Connect Square**.
2. Sign in on Square's website and approve the connection.
3. Back in Inkling, choose the Square location whose stock and prices you want to use.
4. Choose a product to add a draft shop page. Repeat for the products you want online.
5. Open **Ecommerce → Shop pages**, add your story and photos, and publish each page.
   A draft is private. Publishing makes it eligible for the storefront.
6. Set the flat shipping charge in Setup. Zero means free shipping.
7. Have your website manager test the storefront and checkout, then open checkout.

Change prices, stock, product variations, and taxes in Square. Change product
stories, photos, and page titles in Inkling. The shop introduction and shipping
and returns information live under **Ecommerce → Shop introduction**.

The **Recent orders** panel shows the latest 100 orders at the selected location,
including other sales channels. Use Square for payment confirmation, refunds,
shipping, and other fulfillment. An order's status alone does not prove payment.

Connecting a different account or choosing a location pauses checkout. Reconnecting
the same Square merchant keeps its page links; a different merchant cannot sell
through the previous merchant's pages. Sandbox and production pages are separate.
Disconnecting removes Inkling's stored credentials and stops new checkouts. It does
not delete your pages, revoke other sites' access, or close existing payment links.
Close old links or revoke the application in Square when that is what you intend.

## First-version scope

- One Square merchant and one selling location per Inkling installation.
- Fixed-price, whole-quantity physical products, including ordinary size/color variations.
- Shipping-address collection and one flat shipping charge per cart.
- Square catalog taxes and automatic discounts are applied by Square. Configure and
  verify them there; Inkling does not calculate tax obligations.
- No subscriptions, gift cards, appointments, modifiers, measured quantities,
  carrier quotes, delivery-zone restrictions, or pickup scheduling in this version.
- Inventory is checked immediately before creating checkout. A payment link does
  **not** reserve stock. Concurrent purchases and previously issued links can outlive
  the stock check. Shops needing strict reservation guarantees need another flow.
- Inkling is headless. Enabling the plugins adds the admin and storefront APIs;
  your website still renders its product pages and cart.

The older `product` catalog and `/ext/commerce/featured` continue to work. Existing
products are not converted, repriced, or published. Connected pages use a separate
`shopproduct` type with no editable price or stock fields. Create them through
Square Setup so their private Square bindings are recorded. An ordinary manually
created `shopproduct` has no binding and cannot be checked out.

## Website-manager setup

Create a Square application in the [Developer Console](https://developer.squareup.com/apps).
Configure its OAuth redirect URL to match this installation exactly:

```text
https://your-cms.example/ext/square/callback
```

Set the application credentials in the server environment, then restart the process:

```dotenv
SQUARE_ENVIRONMENT=sandbox
SQUARE_APPLICATION_ID=
SQUARE_APPLICATION_SECRET=
```

These are the application's ID and secret, not a seller's personal access token.
They are operator configuration; the shop owner only presses Connect and approves
access on Square. Register the callback for every installation you operate using
that application's supported redirect configuration. `PUBLIC_URL` must be the
CMS's HTTPS origin. Sandbox also permits HTTP on localhost for development.

Enable `square` through the plugin screen, or include it in `PLUGIN_AUTOENABLE` for
an installation you are provisioning. It requires `commerce` and enables it first.
It is not enabled automatically on existing sites by this release.

Use a Sandbox seller to test linking, publishing, out-of-stock behavior, shipping,
taxes, and a completed Square payment. Switching to production requires the
production application credentials, reconnecting, selecting the location, adding
the production products, and deliberately opening checkout again.

The requested OAuth permissions are `MERCHANT_PROFILE_READ`, `ITEMS_READ`,
`INVENTORY_READ`, `ORDERS_READ`, `ORDERS_WRITE`, and `PAYMENTS_WRITE`. Catalog and
inventory writes are not requested. Credentials are encrypted using Inkling's
`SECRET`; do not rotate that value as part of configuring Square.

Square API requests pin version `2026-09-16`. Access tokens renew on demand when
less than 23 days remain. A quiet shop can renew an expired access token with its
non-expiring authorization-code refresh token. Browser-bound, ten-minute OAuth
state is claimed once, and the initiating administrator's permission is checked
again before completing the connection.

## Storefront API

Keep your delivery key on your website's server. Use a key scoped to `shopproduct`
for Square storefront endpoints; add `shop` if it also reads the shop introduction.
These endpoints are server-to-server and deliberately do not enable browser CORS.
Responses use `Cache-Control: no-store`. Do not cache checkout eligibility or prices.

| Method | Endpoint | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/ext/square/products?page=1&limit=20` | Delivery key, `shopproduct` scope | Published linked pages with current Square variations and stock |
| POST | `/ext/square/checkout` | Delivery key, `shopproduct` scope | Validate a cart and create a Square payment link |
| GET | `/ext/square/setup` | Admin/owner human session | Guided setup |
| POST | `/ext/square/setup/:step` | Admin/owner human session | Save `location`, add `product`, save `shipping`, or toggle `checkout`, using `{ "value": "..." }` |
| GET | `/ext/square/connections` | Admin/owner human session | Connection status |
| POST | `/ext/square/connections/square/start` | Admin/owner human session | Begin Square authorization |
| GET | `/ext/square/callback` | One-time browser-bound OAuth state | Finish authorization |
| DELETE | `/ext/square/connections/:id` | Admin/owner human session | Disconnect this installation |
| GET | `/ext/square/orders` | Admin/owner human session | Latest 100 location orders |

`GET /ext/square/products` returns:

```json
{
  "data": [{
    "id": "inkling-entry-id",
    "slug": "blue-mug",
    "title": "Your favorite mug",
    "description": "<p>A little room for a long morning.</p>",
    "image": null,
    "gallery": [],
    "featured": true,
    "squareItemId": "SQUARE_ITEM_ID",
    "squareImages": ["https://images.example/mug.jpg"],
    "variations": [{
      "id": "SQUARE_VARIATION_ID",
      "name": "Blue",
      "sku": "MUG-BLUE",
      "price": { "amount": 1250, "currency": "USD" },
      "tracked": true,
      "available": true,
      "stock": 3
    }]
  }],
  "meta": {
    "page": 1, "limit": 20, "hasMore": false,
    "currency": "USD", "environment": "sandbox", "checkoutEnabled": false
  }
}
```

Amounts are integer minor units: `1250` USD means $12.50. Stock is `null` when
Square does not track that variation. Missing tracked counts are unavailable,
not unlimited. Location price and inventory overrides are respected. Inkling
`image` and `gallery` hold media IDs; resolve them using the normal delivery API.
`squareImages` are the current image URLs from Square. Render text safely and
apply your normal rich-text handling to `description`.

Paging is over published shop pages, with a maximum limit of 50. Unavailable
catalog items can make a page short or empty; continue while `hasMore` is true.
The setup product picker follows Square's catalog cursors, with a 101-page guard
against unbounded requests. Very large catalogs need a paged picker extension.

Submit only identifiers and quantities at checkout:

```json
{
  "idempotencyKey": "a-new-random-uuid-for-this-cart",
  "items": [{
    "productId": "inkling-entry-id",
    "variationId": "SQUARE_VARIATION_ID",
    "quantity": 2
  }]
}
```

Create the key once per checkout attempt. Keep it with the cart and reuse it when
retrying a timeout; use a new key when the cart changes. Square rejects reuse
with a different request. Carts allow up to 50 lines and 99 units per variation.
Duplicate lines are aggregated before checking stock. Submitted prices, tax
overrides, shipping overrides, and redirect URLs are rejected.

The response is `{ "data": { "url": "https://...", "orderId": "...",
"environment": "sandbox" } }`. Navigate the shopper to `data.url`.
Square presents the payment result; Inkling does not accept a browser redirect
as proof of payment. No card information passes through Inkling.

## Connect an embedded storefront

In the website that already calls `createInkling({ siteKeyName: "storefront" })`,
proxy these two routes before your page renderer. The key stays on the server:

```ts
const shop = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url)
  const products = request.method === "GET" && url.pathname === "/shop/products"
  const checkout = request.method === "POST" && url.pathname === "/shop/checkout"
  if (!products && !checkout) return null
  if (!cms.siteKey) return new Response("Shop unavailable", { status: 503 })
  if (checkout && request.headers.get("origin") !== url.origin) {
    return new Response("Invalid origin", { status: 403 })
  }
  const target = new URL(products ? "/ext/square/products" : "/ext/square/checkout", url)
  if (products) {
    target.searchParams.set("page", url.searchParams.get("page") ?? "1")
    target.searchParams.set("limit", "20")
  }
  return cms.fetch(new Request(target, {
    method: products ? "GET" : "POST",
    headers: { "x-api-key": cms.siteKey, "content-type": "application/json" },
    body: checkout ? JSON.stringify(await request.json()) : undefined,
  }))
}
```

Use your site's trusted external origin for the origin check when your reverse
proxy forwards plain HTTP. Keep request body limits and rate limits on the public
proxy. Inkling additionally allows 60 checkout requests per minute per delivery
key and ten authorization starts per ten minutes per administrator.

Your browser cart can then submit the selected items without holding a delivery key:

```ts
const result = await fetch("/shop/checkout", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ idempotencyKey: cart.checkoutKey, items: cart.items }),
})
const payload = await result.json()
if (!result.ok) throw new Error(payload.error ?? "Checkout is unavailable")
window.location.assign(payload.data.url)
```

Display errors beside the cart and keep its contents when checkout fails. Disable
checkout while the request is pending and when the product endpoint reports it
paused. Unpublishing a page or disabling Square prevents new checkouts through
Inkling; it cannot cancel a payment link already issued by Square.

## Provider references

- [Square OAuth](https://developer.squareup.com/docs/oauth-api/overview)
- [Square hosted checkout](https://developer.squareup.com/docs/checkout-api/square-order-checkout)
- [Create payment link and required permissions](https://developer.squareup.com/reference/square/checkout-api/create-payment-link)
- [Catalog API](https://developer.squareup.com/reference/square/catalog-api/list-catalog)
- [Inventory counts](https://developer.squareup.com/reference/square/inventory-api/batch-retrieve-inventory-counts)
