const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
for (const dir of [DATA_DIR, UPLOAD_DIR]) if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
if (!fs.existsSync(PRODUCTS_FILE)) writeJson(PRODUCTS_FILE, []);
if (!fs.existsSync(ORDERS_FILE)) writeJson(ORDERS_FILE, []);

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'souqak_admin',
  secret: process.env.SESSION_SECRET || 'change-this-local-development-secret-please',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${['.jpg','.jpeg','.png','.webp','.gif'].includes(ext) ? ext : '.jpg'}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('يرجى اختيار صورة JPG أو PNG أو WEBP أو GIF فقط.'));
  }
});

function admin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'يلزم تسجيل الدخول إلى لوحة الإدارة.' });
}
function slugify(s) {
  const slug = String(s || 'product').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 55);
  return slug || 'product';
}
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/products', (_, res) => {
  res.json(readJson(PRODUCTS_FILE, []).filter(p => p.active).map(({ id, name, slug, price, oldPrice, description, image, createdAt }) => ({ id, name, slug, price, oldPrice, description, image, createdAt })));
});
app.get('/api/admin/session', (req, res) => res.json({ authenticated: !!req.session.isAdmin }));
app.post('/api/admin/login', (req, res) => {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return res.status(503).json({ error: 'لم تُضبط ADMIN_PASSWORD في إعدادات الخادم.' });
  if (!req.body || req.body.password !== configured) return res.status(401).json({ error: 'كلمة المرور غير صحيحة.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'تعذر إنشاء جلسة الإدارة.' });
    req.session.isAdmin = true;
    res.json({ ok: true });
  });
});
app.post('/api/admin/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/products', admin, (_, res) => res.json(readJson(PRODUCTS_FILE, [])));
app.post('/api/admin/products', admin, (req, res, next) => {
  upload.single('image')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message || 'تعذر رفع الصورة.' });
    try {
      const { name, price, oldPrice, description } = req.body;
      if (!String(name || '').trim()) return res.status(400).json({ error: 'اسم المنتج مطلوب.' });
      if (!Number.isFinite(Number(price)) || Number(price) < 0) return res.status(400).json({ error: 'السعر غير صحيح.' });
      if (!req.file) return res.status(400).json({ error: 'اختر صورة للمنتج.' });
      const products = readJson(PRODUCTS_FILE, []);
      let slug = slugify(name);
      if (products.some(p => p.slug === slug)) slug += '-' + crypto.randomBytes(2).toString('hex');
      const product = {
        id: crypto.randomUUID(), name: String(name).trim().slice(0, 120), slug,
        price: Number(price), oldPrice: oldPrice && Number(oldPrice) > 0 ? Number(oldPrice) : null,
        description: String(description || '').trim().slice(0, 3000),
        image: '/uploads/' + req.file.filename, active: true, createdAt: new Date().toISOString()
      };
      products.unshift(product); writeJson(PRODUCTS_FILE, products);
      res.json({ ok: true, product });
    } catch (e) { next(e); }
  });
});
app.delete('/api/admin/products/:id', admin, (req, res) => {
  const products = readJson(PRODUCTS_FILE, []);
  const p = products.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'المنتج غير موجود.' });
  writeJson(PRODUCTS_FILE, products.filter(x => x.id !== p.id));
  res.json({ ok: true });
});
app.get('/api/admin/orders', admin, (_, res) => res.json(readJson(ORDERS_FILE, [])));
app.patch('/api/admin/orders/:id', admin, (req, res) => {
  const allowed = ['جديد', 'تم الاتصال', 'مؤكد', 'قيد الشحن', 'تم التسليم', 'ملغى'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'حالة الطلب غير صحيحة.' });
  const orders = readJson(ORDERS_FILE, []);
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود.' });
  order.status = req.body.status; writeJson(ORDERS_FILE, orders); res.json({ ok: true, order });
});
app.get('/api/admin/orders.csv', admin, (_, res) => {
  const rows = readJson(ORDERS_FILE, []);
  const headers = ['id','createdAt','productName','quantity','price','name','phone','wilaya','commune','address','status'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ') + '"';
  const csv = '\uFEFF' + [headers.join(','), ...rows.map(o => headers.map(h => esc(o[h])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="souqak-orders.csv"');
  res.send(csv);
});
app.post('/api/order', (req, res) => {
  const { productId, name, phone, wilaya, commune, address, quantity } = req.body || {};
  if (!productId || !String(name || '').trim() || !/^[+0-9\s()-]{8,20}$/.test(String(phone || '')) ||
      !String(wilaya || '').trim() || !String(commune || '').trim() || !String(address || '').trim()) {
    return res.status(400).json({ error: 'يرجى ملء جميع الحقول المطلوبة وإدخال رقم هاتف صحيح.' });
  }
  const products = readJson(PRODUCTS_FILE, []);
  const p = products.find(x => x.id === productId && x.active);
  if (!p) return res.status(404).json({ error: 'هذا المنتج غير متاح حاليًا.' });
  const q = Math.max(1, Math.min(20, parseInt(quantity, 10) || 1));
  const orders = readJson(ORDERS_FILE, []);
  const order = {
    id: crypto.randomUUID().slice(0, 8).toUpperCase(), createdAt: new Date().toISOString(),
    productId: p.id, productName: p.name, quantity: q, price: p.price, total: p.price * q,
    name: String(name).trim().slice(0, 120), phone: String(phone).trim().slice(0, 30),
    wilaya: String(wilaya).trim().slice(0, 80), commune: String(commune).trim().slice(0, 100),
    address: String(address).trim().slice(0, 500), status: 'جديد'
  };
  orders.unshift(order); writeJson(ORDERS_FILE, orders);
  res.json({ ok: true, orderId: order.id });
});
app.get('/p/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'product.html')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ في الخادم. حاول مرة أخرى.' });
});
app.listen(PORT, () => console.log(`Souqak listening on ${PORT}`));
