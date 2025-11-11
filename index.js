const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const PROXY_SECRET = process.env.PROXY_SECRET;

const ALTO_USERNAME = process.env.ALTO_USERNAME;
const ALTO_PASSWORD = process.env.ALTO_PASSWORD;
const ALTO_DATAFEED_ID = process.env.ALTO_DATAFEED_ID;
const ALTO_BRANCH_ID = process.env.ALTO_BRANCH_ID;

const API_BASE = `https://webservices.vebra.com/export/${ALTO_DATAFEED_ID}/v13`;

let cachedToken = null;
let tokenExpiry = null;

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${PROXY_SECRET}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
};

const parseXml = (xml) => {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, { explicitArray: true }, (err, result) => {
      err ? reject(err) : resolve(result);
    });
  });
};

async function getToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('🔑 Using cached token');
    return cachedToken;
  }

  console.log('🔑 Getting new token from Alto...');
  
  const authString = Buffer.from(`${ALTO_USERNAME}:${ALTO_PASSWORD}`).toString('base64');
  
  const response = await axios.get(`${API_BASE}/branch`, {
    headers: {
      'Authorization': `Basic ${authString}`,
      'Accept': 'application/xml'
    }
  });

  const token = response.headers['token'] || response.headers['Token'];
  
  if (!token) {
    throw new Error('No token received from Alto');
  }

  cachedToken = token;
  tokenExpiry = Date.now() + (10 * 60 * 1000);
  
  console.log('✅ New token received');
  return token;
}

async function fetchFromAlto(url, token) {
  const tokenAuth = Buffer.from(`${token}:`).toString('base64');
  
  const response = await axios.get(url, {
    headers: {
      'Authorization': `Basic ${tokenAuth}`,
      'Accept': 'application/xml'
    }
  });
  
  return response.data;
}

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Alto Proxy is running',
    server_ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
  });
});

app.post('/import', authenticate, async (req, res) => {
  try {
    console.log('🔵 Alto Import Request Received');
    
    const { agent_email } = req.body;
    const token = await getToken();
    
    console.log('📦 Fetching properties...');
    const propertiesXml = await fetchFromAlto(
      `${API_BASE}/branch/${ALTO_BRANCH_ID}/property`,
      token
    );
    
    const propertiesData = await parseXml(propertiesXml);
    const properties = propertiesData?.properties?.property || [];
    const propertyList = Array.isArray(properties) ? properties : [properties];
    
    console.log(`✅ Found ${propertyList.length} properties`);
    
    const processedProperties = [];
    let skipped = 0;
    
    for (const propRef of propertyList) {
      const propId = propRef.prop_id?.[0];
      const propertyUrl = propRef.url?.[0];
      
      if (!propId || !propertyUrl) {
        skipped++;
        continue;
      }
      
      try {
        const propertyXml = await fetchFromAlto(propertyUrl, token);
        const propertyData = await parseXml(propertyXml);
        const property = propertyData.property;
        
        const text = [
          get(property, 'letting_type'),
          get(property, 'market'),
          get(property, 'description'),
          get(property, 'title')
        ].join(' ').toLowerCase();
        
        const bedrooms = parseInt(get(property, 'bedrooms')) || 0;
        const isStudent = text.includes('student') || bedrooms >= 3;
        
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
        
        const mapped = mapProperty(property, agent_email);
        if (mapped) {
          processedProperties.push(mapped);
        }
        
      } catch (e) {
        console.error(`Error processing ${propId}:`, e.message);
        skipped++;
      }
    }
    
    console.log(`✅ Processed ${processedProperties.length} properties`);
    
    res.json({
      success: true,
      properties: processedProperties,
      total_found: propertyList.length,
      total: processedProperties.length,
      skipped,
      proxy_ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    });
    
  } catch (error) {
    console.error('❌ Import error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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

function mapProperty(property, agentEmail) {
  try {
    const address = property.address?.[0] || {};
    const price = property.price?.[0] || {};
    const files = property.files || [];
    const fileList = Array.isArray(files) ? files : [files];
    
    const images = fileList.filter(f => get(f, 'type') === '0').map(f => get(f, 'url')).filter(Boolean);
    const floorplans = fileList.filter(f => get(f, 'type') === '2').map(f => get(f, 'url')).filter(Boolean);
    const videos = fileList.filter(f => get(f, 'type') === '3').map(f => get(f, 'url')).filter(Boolean);
    
    return {
      title: get(address, 'display') || get(address, 'street') || 'Property',
      description: get(property, 'description') || '',
      property_type: mapType(parseFloat(get(property, 'rm_type')) || 0),
      street_address: get(address, 'street') || '',
      address: get(address, 'display') || '',
      city: get(address, 'town') || '',
      postcode: get(address, 'postcode') || '',
      bedrooms: parseInt(get(property, 'bedrooms')) || 0,
      bathrooms: parseInt(get(property, 'bathrooms')) || 0,
      price_monthly: parseFloat(get(price, '$t')) || null,
      images: images.length > 0 ? images : undefined,
      floorplans: floorplans.length > 0 ? floorplans : undefined,
      virtual_tours: videos.length > 0 ? videos : undefined,
      landlord_email: agentEmail || undefined,
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

app.listen(PORT, () => {
  console.log(`🚀 Alto Proxy Server running on port ${PORT}`);
  console.log('✅ All Alto requests will come from THIS server's single IP');
});
