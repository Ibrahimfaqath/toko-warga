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

process.loadEnvFile();

const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client, { schema });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const app = new Hono();
app.use('/*', cors());
app.use('/*', serveStatic({ root: './public'}));

const authMiddleware = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ message: 'Unauthorized' }, 401);
    try {
        const token = authHeader.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        c.set('user', payload);
        await next();
    } catch (e) { return c.json({ message: 'Invalid' }, 403); }
};

// API LOGIN & PRODUK (Sama seperti sebelumnya...)
app.post('/api/login', async (c) => {
    const { username, password } = await c.req.json();
    const user = await db.query.users.findFirst({ where: eq(schema.users.username, username) });
    if (!user || !bcrypt.compareSync(password, user.password)) return c.json({ success: false }, 401);
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return c.json({ success: true, token });
});

app.get('/api/products', async (c) => {
    const data = await db.select().from(schema.products).orderBy(desc(schema.products.id));
    return c.json({ success: true, data });
});

// API ORDERS (Simpan Pesanan)
app.post('/api/orders', async (c) => {
    try {
        const { customerName, address, items } = await c.req.json();
        const res = await db.transaction(async (tx) => {
            const [newOrder] = await tx.insert(schema.orders).values({ customerName, address, totalAmount: "0" }).returning();
            let total = 0;
            for (const item of items) {
                const prod = await tx.query.products.findFirst({ where: eq(schema.products.id, item.productId) });
                total += (parseFloat(prod.price) * item.quantity);
                await tx.insert(schema.orderItems).values({ orderId: newOrder.id, productId: item.productId, quantity: item.quantity, priceAtTime: prod.price });
                await tx.update(schema.products).set({ stock: prod.stock - item.quantity }).where(eq(schema.products.id, item.productId));
            }
            await tx.update(schema.orders).set({ totalAmount: total.toString() }).where(eq(schema.orders.id, newOrder.id));
            return newOrder.id;
        });
        return c.json({ success: true, orderId: res });
    } catch (e) { return c.json({ success: false, message: e.message }, 400); }
});

// API ADMIN ORDERS (Tampilkan di Dashboard)
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

// (Rute POST/PUT/DELETE Produk tetap ada di bawah sini...)
app.post('/api/products', authMiddleware, async (c) => { /* ... kode upload supabase ... */ });

const port = 2112;
serve({ fetch: app.fetch, port });