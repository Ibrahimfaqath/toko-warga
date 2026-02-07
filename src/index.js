import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema.js';
import { eq, desc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

// Load variabel dari file .env
process.loadEnvFile();

// Inisialisasi Database (Postgres via Drizzle)
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client, { schema });

// Inisialisasi Supabase (Untuk Simpan Gambar)
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_SERVICE_KEY
);

const app = new Hono();

// Middleware
app.use('/*', cors());
app.use('/*', serveStatic({ root: './public' }));

// Middleware Autentikasi Admin
const authMiddleware = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ message: 'Unauthorized' }, 401);
    try {
        const token = authHeader.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        c.set('user', payload);
        await next();
    } catch (e) { 
        return c.json({ message: 'Sesi habis, silakan login ulang' }, 403); 
    }
};

// --- API AUTH ---
app.post('/api/login', async (c) => {
    const { username, password } = await c.req.json();
    const user = await db.query.users.findFirst({ 
        where: eq(schema.users.username, username) 
    });

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return c.json({ success: false, message: 'Username atau password salah' }, 401);
    }

    const token = jwt.sign(
        { id: user.id, role: user.role }, 
        process.env.JWT_SECRET, 
        { expiresIn: '1d' }
    );
    return c.json({ success: true, token });
});

// --- API PRODUK (PUBLIK) ---
app.get('/api/products', async (c) => {
    const data = await db.select().from(schema.products).orderBy(desc(schema.products.id));
    return c.json({ success: true, data });
});

// --- API PESANAN (USER + VALIDASI STOK) ---
app.post('/api/orders', async (c) => {
    try {
        const { customerName, address, items } = await c.req.json();
        
        const result = await db.transaction(async (tx) => {
            // 1. Buat Header Pesanan
            const [newOrder] = await tx.insert(schema.orders).values({
                customerName, address, totalAmount: "0", status: 'pending'
            }).returning();

            let total = 0;

            // 2. Proses Item & Cek Stok
            for (const item of items) {
                const product = await tx.query.products.findFirst({ 
                    where: eq(schema.products.id, item.productId) 
                });

                if (!product || product.stock < item.quantity) {
                    throw new Error(`Maaf, stok ${product?.name || 'produk'} tidak mencukupi!`);
                }

                total += (parseFloat(product.price) * item.quantity);

                // Input ke Detail Pesanan
                await tx.insert(schema.orderItems).values({
                    orderId: newOrder.id,
                    productId: item.productId,
                    quantity: item.quantity,
                    priceAtTime: product.price
                });

                // Potong Stok Produk
                await tx.update(schema.products)
                    .set({ stock: product.stock - item.quantity })
                    .where(eq(schema.products.id, item.productId));
            }

            // 3. Update Total Harga Akhir
            await tx.update(schema.orders)
                .set({ totalAmount: total.toString() })
                .where(eq(schema.orders.id, newOrder.id));

            return newOrder.id;
        });

        return c.json({ success: true, orderId: result });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 400);
    }
});

// --- API ADMIN (MANAJEMEN PESANAN) ---
app.get('/api/admin/orders', authMiddleware, async (c) => {
    const data = await db.query.orders.findMany({
        with: { items: { with: { product: true } } },
        orderBy: desc(schema.orders.id)
    });
    return c.json({ success: true, data });
});

app.patch('/api/orders/:id/status', authMiddleware, async (c) => {
    const id = parseInt(c.req.param('id'));
    const { status } = await c.req.json();
    await db.update(schema.orders).set({ status }).where(eq(schema.orders.id, id));
    return c.json({ success: true });
});

// --- API ADMIN (MANAJEMEN PRODUK) ---
app.post('/api/products', authMiddleware, async (c) => {
    try {
        const body = await c.req.parseBody();
        const imageFile = body['image'];
        
        // Upload Gambar ke Supabase
        const fileName = `prod_${Date.now()}_${imageFile.name.replace(/\s/g, '_')}`;
        const arrayBuffer = await imageFile.arrayBuffer();
        
        const { error: uploadError } = await supabase.storage
            .from('products')
            .upload(fileName, arrayBuffer, { contentType: imageFile.type });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from('products').getPublicUrl(fileName);

        // Simpan ke Database
        await db.insert(schema.products).values({
            name: body['name'],
            description: body['description'],
            price: body['price'],
            stock: parseInt(body['stock']),
            categoryId: parseInt(body['categoryId']),
            imageUrl: data.publicUrl
        });

        return c.json({ success: true });
    } catch (e) { 
        return c.json({ success: false, message: e.message }, 500); 
    }
});

app.put('/api/products/:id', authMiddleware, async (c) => {
    const id = parseInt(c.req.param('id'));
    try {
        const body = await c.req.parseBody();
        const updateData = {
            name: body['name'],
            description: body['description'],
            price: body['price'],
            stock: parseInt(body['stock']),
            categoryId: parseInt(body['categoryId'])
        };

        const imageFile = body['image'];
        if (imageFile && imageFile instanceof File && imageFile.size > 0) {
            const fileName = `upd_${Date.now()}_${imageFile.name.replace(/\s/g, '_')}`;
            const arrayBuffer = await imageFile.arrayBuffer();
            
            await supabase.storage.from('products').upload(fileName, arrayBuffer, { contentType: imageFile.type });
            const { data } = supabase.storage.from('products').getPublicUrl(fileName);
            updateData.imageUrl = data.publicUrl;
        }

        await db.update(schema.products).set(updateData).where(eq(schema.products.id, id));
        return c.json({ success: true });
    } catch (e) { 
        return c.json({ success: false, message: e.message }, 500); 
    }
});

app.delete('/api/products/:id', authMiddleware, async (c) => {
    const id = parseInt(c.req.param('id'));
    try {
        const product = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
        if (!product) return c.json({ success: false, message: "Produk tidak ditemukan" });

        // Hapus detail pesanan yang terkait produk ini (agar tidak error constraint)
        await db.delete(schema.orderItems).where(eq(schema.orderItems.productId, id));
        
        // Hapus Produk
        await db.delete(schema.products).where(eq(schema.products.id, id));
        
        return c.json({ success: true });
    } catch (e) { 
        return c.json({ success: false, message: e.message }, 500); 
    }
});

// Jalankan Server
const port = 2112;
console.log(`Server berjalan di http://localhost:${port}`);
serve({ fetch: app.fetch, port });