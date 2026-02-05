// src/index.js
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { desc } from 'drizzle-orm';

// 1. LOAD ENV
process.loadEnvFile();

// 2. Setup Koneksi 
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client, { schema });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = new Hono();
app.use('/*', cors());
app.use('/*', serveStatic({ root: './public'}));

// ,,, API LOGIN ,,,
app.post('/api/login', async (c) => {
    const { username, password } = await c.req.json();

    // Cari user
    const user = await db.query.users.findFirst({
        where: eq(schema.users.username, username)
    });

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return c.json({ success: false, message: 'Login Gagal' }, 401);
    }

    // Buat Token 
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return c.json({ success: true, token });
});

// Middleware Auth
const authMiddleware = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ message: 'Unauthorized' }, 401);
    try {
        const token = authHeader.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        c.set('user', payload);
        await next();
    } catch (e) {
        return c.json({ message: 'Invalid Token' }, 403);
    }
};

// API Upload Produk (Admin Only)
app.post('/api/products', authMiddleware, async (c) => {
    try {
        const body = await c.req.parseBody();
        const imageFile = body['image']; // Ambil file dari form-data

        // validasi
        if (!imageFile || !(imageFile instanceof File)) {
            return c.json({ success: false, message: 'Gambar wajib!' }, 400);
        }

        // 1. Upload ke Supabase Storage
        const fileName = `prod_${Date.now()}_${imageFile.name.replace(/\s/g, '_')}`;
        const arrayBuffer = await imageFile.arrayBuffer(); // Ubah ke buffer

        const { error: uploadError } = await supabase.storage
            .from('products')
            .upload(fileName, arrayBuffer, { contentType: imageFile.type });

        if (uploadError) throw uploadError;

        // 2. Ambil Public URL
        const { data } = supabase.storage.from('products').getPublicUrl(fileName);
        const imageUrl = data.publicUrl;

        // 3. Simpan ke Database
        await db.insert(schema.products).values({
            name: body['name'],
            description: body['description'],
            price: body['price'],
            stock: parseInt(body['stock']),
            categoryId: parseInt(body['categoryId']),
            imageUrl: imageUrl
        });

        return c.json({ success: true, message: 'Produk Tersimpan', imageUrl })
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// API List Product (Public)

app.get('/api/products', async (c) => {
    const data = await db.select().from(schema.products).orderBy(desc(schema.products.id));
    return c.json({ success: true, data });
});

// API Checkout (Public)
app.post('/api/orders', async (c) => {
    const { customerName, address, items } = await c.req.json();
    // items: [{ productId: 1, quantity: 2 }]

    try {
        const result = await db.transaction(async (tx) => {
            let total = 0;

            // 1. Buat Order Header
            const [newOrder] = await tx.insert(schema.orders).values({
                customerName, address, totalAmount: "0", status: 'pending'
            }).returning();

            // 2. Proses Items
            for (const item of items) {
                // Cek Stok
                const product = await tx.query.products.findFirst({
                    where: eq(schema.products.id, item.productId)
                });

                if (!product || product.stock < item.quantity) {
                    throw new Error(`Stok ${product?.name} kurang!`);
                }

                total += (parseFloat(product.price) * item.quantity);

                // Catat Item & Kurangi Stok
                await tx.insert(schema.orderItems).values({
                    orderId: newOrder.id,
                    productId: item.productId,
                    quantity: item.quantity,
                    priceAtTime: product.price
                });

                await tx.update(schema.products)
                    .set({ stock: product.stock - item.quantity })
                    .where(eq(schema.products.id, item.productId));
            }

            // Update Total Harga
            await tx.update(schema.orders)
                .set({ totalAmount: total.toString() })
                .where(eq(schema.orders.id, newOrder.id));

            return { orderId: newOrder.id, total };
        })

        return c.json({ success: true, ...result });

    } catch (e) {
        return c.json({ success: false, message: e.message }, 400);
    }
});

// 1. API DELETE PRODUK
app.delete('/api/products/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    try {
        // Ambil data produk untuk mendapatkan URL gambar
        const product = await db.query.products.findFirst({
            where: eq(schema.products.id, parseInt(id))
        });

        if (!product) return c.json({ success: false, message: 'Produk tidak ditemukan' }, 404);

        // Hapus file dari Supabase Storage (opsional tapi disarankan)
        const fileName = product.imageUrl.split('/').pop();
        await supabase.storage.from('products').remove([fileName]);

        // Hapus dari Database
        await db.delete(schema.products).where(eq(schema.products.id, parseInt(id)));

        return c.json({ success: true, message: 'Produk berhasil dihapus' });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// 2. API UPDATE PRODUK
app.put('/api/products/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    try {
        const body = await c.req.parseBody();
        const updateData = {
            name: body['name'],
            description: body['description'],
            price: body['price'],
            stock: parseInt(body['stock']),
            categoryId: parseInt(body['categoryId']),
        };

        const imageFile = body['image'];
        if (imageFile && imageFile instanceof File) {
            // Logika upload gambar baru jika ada
            const fileName = `prod_${Date.now()}_${imageFile.name.replace(/\s/g, '_')}`;
            const arrayBuffer = await imageFile.arrayBuffer();
            await supabase.storage.from('products').upload(fileName, arrayBuffer, { contentType: imageFile.type });
            const { data } = supabase.storage.from('products').getPublicUrl(fileName);
            updateData.imageUrl = data.publicUrl;
        }

        await db.update(schema.products).set(updateData).where(eq(schema.products.id, parseInt(id)));
        return c.json({ success: true, message: 'Produk berhasil diupdate' });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// API DELETE PRODUK
app.delete('/api/products/:id', authMiddleware, async (c) => {
    const id = c.req.param('id');
    try {
        // 1. Cari data produk untuk mendapatkan URL gambarnya
        const product = await db.query.products.findFirst({
            where: eq(schema.products.id, parseInt(id))
        });

        if (!product) return c.json({ success: false, message: 'Produk tidak ditemukan' }, 404);

        // 2. Hapus file gambar di Supabase Storage agar tidak penuh
        const fileName = product.imageUrl.split('/').pop();
        await supabase.storage.from('products').remove([fileName]);

        // 3. Hapus data dari Database
        await db.delete(schema.products).where(eq(schema.products.id, parseInt(id)));

        return c.json({ success: true, message: 'Produk berhasil dihapus' });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// Code untuk menjalankan server
const port = 2112;
console.log(`Server running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });
