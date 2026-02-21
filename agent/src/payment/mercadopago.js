import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { config } from '../config.js';

const client = new MercadoPagoConfig({
  accessToken: config.mercadopago.accessToken,
});

const preferenceClient = new Preference(client);
const paymentClient = new Payment(client);

/**
 * Create a Mercado Pago checkout preference
 */
export async function createCheckout({ cpf, name, email, service, price }) {
  const siteUrl = config.site.url;
  // Extract base domain for webhook (without /cadastro path, without www)
  const baseUrl = new URL(siteUrl).origin.replace("://www.", "://");

  const preference = await preferenceClient.create({
    body: {
      items: [
        {
          id: service.toLowerCase().replace(/\s+/g, '-'),
          title: `CredPositivo - ${service}`,
          description: `Serviço: ${service}`,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: parseFloat(price),
        },
      ],
      payer: {
        name: name || '',
        email: email || '',
        identification: {
          type: 'CPF',
          number: cpf,
        },
      },
      back_urls: {
        success: `${baseUrl}/dash/servicos.html?payment=success`,
        failure: `${baseUrl}/dash/servicos.html?payment=failure`,
        pending: `${baseUrl}/dash/servicos.html?payment=pending`,
      },
      auto_return: 'approved',
      external_reference: cpf,
      notification_url: `${baseUrl}/webhook/mercadopago`,
      statement_descriptor: 'CREDPOSITIVO',
    },
  });

  return {
    preferenceId: preference.id,
    initPoint: preference.init_point,
    sandboxInitPoint: preference.sandbox_init_point,
  };
}

/**
 * Get payment details from Mercado Pago
 */
export async function getPayment(paymentId) {
  const payment = await paymentClient.get({ id: paymentId });
  return payment;
}
