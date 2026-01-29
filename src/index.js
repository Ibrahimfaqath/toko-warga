// src/index.js
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';

// 1. LOAD ENV
process.loadEnvFile();

// 2. Setup Koneksi 
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client, { schema });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = new Hono();
app.use('/*', cors());

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
        const token = authHeader.split('')[1];
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
            return c.json({ success: false, message: 'Gambar wajib!'}, 400);
        }

        // 1. Upload ke Supabase Storage
        const fileName = `prod_${Date.now()}_@{imageFile.name.replace(/\s/g, '_')}`;
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

        return c.json({ success: true, message: 'Produk Tersimpan', imageUrl})
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// Code untuk menjalankan server
const port = 2112;
console.log(`Server running at http://localhost:${port}`);
serve({ fetch: app.fetch, port});
