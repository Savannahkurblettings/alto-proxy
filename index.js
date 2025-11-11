import express from 'express';
import fetch from 'node-fetch';
import { parseString } from 'xml2js';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ALTO_USERNAME = process.env.ALTO_USERNAME;
const ALTO_PASSWORD = process.env.ALTO_PASSWORD;
const ALTO_DATAFEED_ID = process.env.ALTO_DATAFEED_ID;
const ALTO_BRANCH_ID = process.env.ALTO_BRANCH_ID || '44928';
const PROXY_SECRET = process.env.PROXY_SECRET;

let cachedToken = null;
let tokenTimestamp = null;
const TOKEN_TTL = 20 * 60 * 1000;

function get(obj, path) {
  const keys = path.split('.');
  let result = obj;
  for (const key of keys) {
    result = result?.[key];
    if (result === undefined) return null;
  }
  if (Array.isArray(result) && result.length > 0) return result[0];
  return result || null;
}

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, { explicitArray: true }, (err, result) => {
      err ? reject(err) : resolve(result);
    });
  });
}

async function getToken() {
  const now = Date.now();
  
  if (cachedToken && tokenTimestamp && (now - tokenTimestamp < TOKEN_TTL)) {
    console.log('✅ Using cached token');
    return cachedToken;
  }
  
  console.log('🔑 Getting new token from Alto...');
  
  const authBase64 = Buffer.from(`${ALTO_USERNAME}:${ALTO_PASSWORD}`).toString('base64');
  const apiBase = `https://webservices.vebra.com/export/${ALTO_DATAFEED_ID}/v13`;
  
  const response = await fetch(`${apiBase}/branch`, {
    headers: {
      'Authorization': `Basic ${authBase64}`,
      'Accept': 'application/xml'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get token: ${response.status}`);
  }
  
  const token = response.headers.get('token') || response.headers.get('Token');
  
  if (!token) {
    throw new Error('No token received from Alto');
  }
  
  console.log(`✅ New token received`);
  
  cachedToken = token;
  tokenTimestamp = now;
  
  return token;
}

async function fetchWithToken(url, token) {
  const tokenAuth = Buffer.from(`${token}:`).toString('base64');
  
  return await fetch(url, {
    headers: {
      'Authorization': `Basic ${tokenAuth}`,
      'Accept': 'application/xml'
    }
  });
}

function mapProperty(property, agentEmail) {
  try {
    const address = property.address?.[0] || {};
    const price = property.price?.[0] || {};
    const files = property.files || [];
    const fileList = Array.isArray(files) ? files : [files];
    
    const images = fileList.filter(f => get(f, 'type') === '0').map(f => get(f, 'url')).filter(Boolean);
    const floorplans = fileList.filter(f => get(f, 'type') === '2').map(f => get(f, 'url')).filter(Boolean);
    const videos = fileList.filter(f => get(f, 'type') === '3').map(f => get(f, 'url')).filter(Boolean);
    const bullets = property.bullets || [];
    const bulletList = Array.isArray(bullets) ? bullets : [bullets];
    const amenities = bulletList.map(b => get(b, 'bullet')).filter(Boolean);
    
    return {
      title: get(address, 'display') || get(address, 'street') || 'Property',
      description: get(property, 'description') || '',
      property_type: mapType(parseFloat(get(property, 'rm_type')) || 0),
      street_address: get(address, 'street') || '',
      address: get(address, 'display') || '',
      city: get(address, 'town') || '',
      postcode: get(address, 'postcode') || '',
      latitude: parseFloat(get(property, 'latitude')) || null,
      longitude: parseFloat(get(property, 'longitude')) || null,
      bedrooms: parseInt(get(property, 'bedrooms')) || 0,
      bathrooms: parseInt(get(property, 'bathrooms')) || 0,
      price_monthly: parseFloat(get(price, '$t')) || null,
      deposit_amount: parseFloat(get(property, 'deposit')) || null,
      available_from: get(property, 'available') || '',
      furnished: get(property, 'furnished') === '1',
      bills_included: false,
      epc_rating: get(property, 'epcrating_current'),
      council_tax_band: get(property, 'counciltaxband'),
      images: images.length > 0 ? images : undefined,
      floorplans: floorplans.length > 0 ? floorplans : undefined,
      virtual_tours: videos.length > 0 ? videos : undefined,
      amenities: amenities.length > 0 ? amenities : undefined,
      landlord_email: agentEmail || undefined,
      landlord_account_type: 'agent',
      status: 'available',
      external_id: get(property, 'prop_id'),
    };
  } catch (e) {
    return null;
  }
}

function mapType(rmType) {
  if (rmType >= 1 && rmType <= 6) return 'house';
  if (rmType === 9) return 'studio';
  return 'flat';
}

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  
  const authHeader = req.headers.authorization;
  const expectedAuth = `Bearer ${PROXY_SECRET}`;
  
  if (!authHeader || authHeader !== expectedAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Alto Proxy', timestamp: new Date().toISOString() });
});

app.post('/import', async (req, res) => {
  try {
    console.log('\n🔵 Alto Import Request Received');
    
    const agentEmail = req.body.agent_email;
    const apiBase = `https://webservices.vebra.com/export/${ALTO_DATAFEED_ID}/v13`;
    
    const token = await getToken();
    
    console.log('📦 Fetching properties...');
    const propertiesResponse = await fetchWithToken(`${apiBase}/branch/${ALTO_BRANCH_ID}/property`, token);
    
    if (!propertiesResponse.ok) {
      throw new Error(`Failed to fetch properties: ${propertiesResponse.status}`);
    }
    
    const propertiesXml = await propertiesResponse.text();
    const propertiesData = await parseXml(propertiesXml);
    const properties = propertiesData?.properties?.property || [];
    const propertyList = Array.isArray(properties) ? properties : [properties];
    
    console.log(`Found ${propertyList.length} properties`);
    
    const processedProperties = [];
    let skipped = 0;
    let errors = 0;
    
    for (const propertyRef of propertyList) {
      const propId = propertyRef.prop_id?.[0];
      const propertyUrl = propertyRef.url?.[0];
      
      if (!propId || !propertyUrl) {
        skipped++;
        continue;
      }
      
      try {
        const propertyResponse = await fetchWithToken(propertyUrl, token);
        
        if (!propertyResponse.ok) {
          errors++;
          continue;
        }
        
        const propertyXml = await propertyResponse.text();
        const propertyData = await parseXml(propertyXml);
        const property = propertyData.property;
        
        const text = [
          get(property, 'letting_type'),
          get(property, 'market'),
          get(property, 'description'),
          get(property, 'title')
        ].join(' ').toLowerCase();
        
        const bedrooms = parseInt(get(property, 'bedrooms')) || 0;
        const isStudent = text.includes('student') || bedrooms >= 3 || 
                         text.includes('letting') || text.includes('to let');
        
        if (!isStudent) {
          skipped++;
          continue;
        }
        
        const webStatus = get(property, 'web_status');
        const isAvailable = !webStatus || webStatus === '0' || webStatus === '100';
        
        if (!isAvailable) {
          skipped++;
          continue;
        }
        
        const kurblyProperty = mapProperty(property, agentEmail);
        if (kurblyProperty) {
          processedProperties.push(kurblyProperty);
        } else {
          errors++;
        }
        
      } catch (e) {
        errors++;
        console.error(`Error processing ${propId}:`, e.message);
      }
    }
    
    console.log('✅ Import complete');
    console.log(`Processed: ${processedProperties.length}`);
    
    res.json({
      success: true,
      properties: processedProperties,
      total: processedProperties.length,
      total_found: propertyList.length,
      skipped,
      errors,
      proxy_ip: req.ip || 'unknown',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Import error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Alto Proxy Server running on port ${PORT}`);
  console.log(`✅ All Alto requests will come from THIS server's single IP\n`);
});
