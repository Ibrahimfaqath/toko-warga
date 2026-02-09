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
    } catch (e) { return c.json({ message: 'Invalid Token' }, 403); }
};

// API LOGIN
app.post('/api/login', async (c) => {
    const { username, password } = await c.req.json();
    const user = await db.query.users.findFirst({ where: eq(schema.users.username, username) });
    if (!user || !bcrypt.compareSync(password, user.password)) return c.json({ success: false }, 401);
    const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1d' });
    return c.json({ success: true, token });
});

// GET PRODUCTS & CATEGORIES
app.get('/api/products', async (c) => {
    const products = await db.select().from(schema.products).orderBy(desc(schema.products.id));
    const categories = await db.select().from(schema.categories);
    return c.json({ success: true, data: products, categories });
});

// CREATE PRODUCT
app.post('/api/products', authMiddleware, async (c) => {
    try {
        const body = await c.req.parseBody();
        const imageFile = body['image'];
        const fileName = `prod_${Date.now()}_${imageFile.name}`;
        await supabase.storage.from('products').upload(fileName, await imageFile.arrayBuffer(), { contentType: imageFile.type });
        const { data } = supabase.storage.from('products').getPublicUrl(fileName);

        await db.insert(schema.products).values({
            name: body['name'],
            description: body['description'],
            price: body['price'],
            stock: parseInt(body['stock']),
            categoryId: parseInt(body['categoryId']),
            imageUrl: data.publicUrl
        });
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false, message: e.message }, 500); }
});

// UPDATE PRODUCT
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
        if (body['image'] && body['image'].size > 0) {
            const fileName = `upd_${Date.now()}_${body['image'].name}`;
            await supabase.storage.from('products').upload(fileName, await body['image'].arrayBuffer(), { contentType: body['image'].type });
            updateData.imageUrl = supabase.storage.from('products').getPublicUrl(fileName).data.publicUrl;
        }
        await db.update(schema.products).set(updateData).where(eq(schema.products.id, id));
        return c.json({ success: true });
    } catch (e) { return c.json({ success: false, message: e.message }, 500); }
});

// DELETE PRODUCT
app.delete('/api/products/:id', authMiddleware, async (c) => {
    const id = parseInt(c.req.param('id'));
    await db.delete(schema.orderItems).where(eq(schema.orderItems.productId, id));
    await db.delete(schema.products).where(eq(schema.products.id, id));
    return c.json({ success: true });
});

// ORDERS
app.get('/api/admin/orders', authMiddleware, async (c) => {
    const data = await db.query.orders.findMany({ with: { items: { with: { product: true } } }, orderBy: desc(schema.orders.id) });
    return c.json({ success: true, data });
});

app.post('/api/orders', async (c) => {
    const { customerName, address, items } = await c.req.json();
    const result = await db.transaction(async (tx) => {
        const [newOrder] = await tx.insert(schema.orders).values({ customerName, address, totalAmount: "0", status: 'pending' }).returning();
        let total = 0;
        for (const item of items) {
            const prod = await tx.query.products.findFirst({ where: eq(schema.products.id, item.productId) });
            total += (parseFloat(prod.price) * item.quantity);
            await tx.insert(schema.orderItems).values({ orderId: newOrder.id, productId: item.productId, quantity: item.quantity, priceAtTime: prod.price });
        }
        await tx.update(schema.orders).set({ totalAmount: total.toString() }).where(eq(schema.orders.id, newOrder.id));
        return newOrder.id;
    });
    return c.json({ success: true, orderId: result });
});

app.patch('/api/orders/:id/status', authMiddleware, async (c) => {
    const id = parseInt(c.req.param('id'));
    const { status } = await c.req.json();
    await db.update(schema.orders).set({ status }).where(eq(schema.orders.id, id));
    return c.json({ success: true });
});

app.delete('/api/orders/:id', authMiddleware, async (c) => {
    const id = parseInt(c.req.param('id'));
    await db.delete(schema.orderItems).where(eq(schema.orderItems.orderId, id));
    await db.delete(schema.orders).where(eq(schema.orders.id, id));
    return c.json({ success: true });
});

serve({ fetch: app.fetch, port: 2112 });