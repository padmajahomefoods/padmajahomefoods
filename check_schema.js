const http = require('https');
const req = http.request('https://ndduvgiiebgqplinjaxq.supabase.co/rest/v1/', {
  headers: {
    'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kZHV2Z2lpZWJncXBsaW5qYXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDg0NTIsImV4cCI6MjA5OTY4NDQ1Mn0.TrvCCwWEcTnmDK4IQ_LEpY1FO_DLS-3kn08lRs6SmzU',
    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kZHV2Z2lpZWJncXBsaW5qYXhxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxMDg0NTIsImV4cCI6MjA5OTY4NDQ1Mn0.TrvCCwWEcTnmDK4IQ_LEpY1FO_DLS-3kn08lRs6SmzU'
  }
}, (res) => {
  let data = '';
  res.on('data', (c) => data += c);
  res.on('end', () => {
    try {
      const o = JSON.parse(data);
      console.log(Object.keys(o));
      const schemas = o.definitions || o.components?.schemas || {};
      const ordersSchema = schemas.orders?.properties || {};
      console.log('payment_method:', 'payment_method' in ordersSchema);
      console.log('payment_status:', 'payment_status' in ordersSchema);
    } catch (e) {
      console.error(e);
    }
  });
});
req.end();
