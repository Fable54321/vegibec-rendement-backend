# Microsoft Graph setup for RFQ Outlook links

The RFQ application uses delegated Microsoft Graph access. Each application user
connects their own Microsoft 365 mailbox, selects messages, and later opens the
original message through Outlook on the web.

## 1. Register the application

In Microsoft Entra admin center:

1. Create an app registration.
2. Add a **Web** redirect URI matching the backend callback exactly:

   `https://api.vegibec-portail.com/sales/outlook/callback`

3. Add these delegated Microsoft Graph permissions:

   - `User.Read`
   - `Mail.ReadBasic`
   - `offline_access`
   - `openid`
   - `profile`

4. Create a client secret and store its value securely.
5. Grant tenant-wide admin consent if required by the organization’s policy.

The integration requests immutable Outlook IDs, so moving a message between
folders in the same mailbox does not break its RFQ link.

## 2. Configure the backend

Add these environment variables:

```env
MICROSOFT_CLIENT_ID=<Entra application client ID>
MICROSOFT_CLIENT_SECRET=<Entra client secret value>
MICROSOFT_TENANT_ID=<Microsoft 365 tenant ID>
MICROSOFT_REDIRECT_URI=https://api.vegibec-portail.com/sales/outlook/callback
MICROSOFT_TOKEN_ENCRYPTION_KEY=<random secret of at least 32 characters>
OUTLOOK_FRONTEND_URL=https://devis.vegibec-portail.com
```

Generate `MICROSOFT_TOKEN_ENCRYPTION_KEY` with a cryptographically secure secret
generator. Changing it later invalidates existing encrypted Microsoft
connections, so users would need to reconnect Outlook.

For local development, register an additional redirect URI such as
`http://localhost:3000/sales/outlook/callback` and use matching local backend and
frontend environment values.

## 3. Apply the database schema

Run the updated SQL file against the application database:

`app/scripts/createSalesRfqTables.sql`

It creates:

- `sales.microsoft_connections` for encrypted delegated tokens;
- `sales.rfq_email_links` for immutable message references and display metadata.

No email body or Outlook attachment is copied into these tables.

## 4. Deploy

Deploy the database update before the backend and frontend releases. Users can
then select **Connecter Outlook** in an RFQ entry and consent to mailbox metadata
access.
