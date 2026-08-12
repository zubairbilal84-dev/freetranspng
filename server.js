const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Session setup for secure admin login
app.use(session({
    secret: 'freetranspng_super_secret_key',
    resave: false,
    saveUninitialized: true
}));

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/freetranspng')
.then(() => console.log('MongoDB Connected Successfully!'))
.catch(err => console.log('DB Connection Error:', err));

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }
});
const Category = mongoose.model('Category', categorySchema);

const pngSchema = new mongoose.Schema({
    title: { type: String, required: true },
    category: { type: String, required: true },
    tags: { type: String, required: true },
    imageUrl: { type: String, required: true },
    downloads: { type: Number, default: 0 }
});
const Png = mongoose.model('Png', pngSchema);

// Visitor Analytics Schema
const visitorSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now }
});
const Visitor = mongoose.model('Visitor', visitorSchema);

// Middleware to track visits
app.use(async (req, res, next) => {
    if (!req.url.startsWith('/uploads') && !req.url.startsWith('/admin') && !req.url.startsWith('/api')) {
        await Visitor.create({});
    }
    next();
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, path.join(__dirname, 'public/uploads')); },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-')); }
});
const upload = multer({ storage: storage });

// --- ADMIN AUTHENTICATION MIDDLEWARE ---
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

// --- ROUTES ---

app.get('/', async (req, res) => {
    try {
        const search = req.query.search || '';
        const selectedCategory = req.query.category || '';
        
        let query = {};
        if (selectedCategory) {
            query.category = selectedCategory;
        }
        if (search) {
            query.$or = [
                { title: { $regex: search, $options: 'i' } },
                { tags: { $regex: search, $options: 'i' } },
                { category: { $regex: search, $options: 'i' } }
            ];
        }
        
        const pngs = await Png.find(query).sort({ _id: -1 });
        const categories = await Category.find().sort({ name: 1 });
        
        // Clean tags and titles extraction (No # symbol, no prefixes)
        const allPngs = await Png.find().limit(15);
        let popularTags = [];
        allPngs.forEach(item => {
            if(item.title) popularTags.push(item.title.trim());
            if(item.tags) {
                let tArr = item.tags.split(',').map(t => t.trim().replace(/#/g, '').replace(/tag[:\s]*/gi, ''));
                popularTags.push(...tArr);
            }
        });
        
        // Remove duplicate or empty strings
        popularTags = [...new Set(popularTags.filter(Boolean))];

        if(popularTags.length === 0) {
            popularTags = ['Diya', 'Logo', 'Vector', 'Ribbon', 'Banner', 'Icon'];
        }

        res.render('index', { pngs, search, categories, selectedCategory, popularTags });
    } catch (err) { res.status(500).send("Server Error"); }
});

// Live Search Autocomplete API Route
app.get('/api/search-suggestions', async (req, res) => {
    try {
        const q = req.query.q || '';
        const results = await Png.find({
            $or: [
                { title: { $regex: q, $options: 'i' } },
                { tags: { $regex: q, $options: 'i' } },
                { category: { $regex: q, $options: 'i' } }
            ]
        }).limit(5);
        res.json(results);
    } catch (err) { res.json([]); }
});

// E-commerce Style Product Detail Page & Recommendations Route
app.get('/png/:id', async (req, res) => {
    try {
        const png = await Png.findById(req.params.id);
        if (!png) return res.status(404).send("PNG not found");
        
        png.downloads += 1;
        await png.save();

        const recommendations = await Png.find({ category: png.category, _id: { $ne: png._id } }).limit(4);
        res.render('detail', { png, recommendations });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/download/:id', async (req, res) => {
    res.redirect(`/png/${req.params.id}`);
});

// Static Pages for AdSense & Navigation
app.get('/about', (req, res) => res.render('about'));
app.get('/contact', (req, res) => res.render('contact'));
app.get('/privacy', (req, res) => res.render('privacy'));

// --- ADMIN LOGIN & AUTH ROUTES ---
app.get('/admin/login', (req, res) => {
    res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
    const { email, password } = req.body;
    if (email === 'rihanandshifaan@0990' && password === 'rihan&shifaan123') {
        req.session.isAdmin = true;
        res.redirect('/admin');
    } else {
        res.render('admin-login', { error: 'Invalid Email or Password' });
    }
});

app.get('/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.redirect('/admin/login');
});

// --- PROTECTED ADMIN ROUTES ---
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfWeek = new Date();
        startOfWeek.setDate(now.getDate() - 7);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        const dailyVisits = await Visitor.countDocuments({ timestamp: { $gte: startOfDay } });
        const weeklyVisits = await Visitor.countDocuments({ timestamp: { $gte: startOfWeek } });
        const monthlyVisits = await Visitor.countDocuments({ timestamp: { $gte: startOfMonth } });

        const searchAdmin = req.query.search || '';
        const selectedCategory = req.query.category || '';
        
        let query = {};
        if (selectedCategory && searchAdmin) {
            query = {
                category: selectedCategory,
                $or: [
                    { title: { $regex: searchAdmin, $options: 'i' } },
                    { tags: { $regex: searchAdmin, $options: 'i' } }
                ]
            };
        } else if (selectedCategory) {
            query.category = selectedCategory;
        } else if (searchAdmin) {
            query = { 
                $or: [
                    { title: { $regex: searchAdmin, $options: 'i' } },
                    { tags: { $regex: searchAdmin, $options: 'i' } },
                    { category: { $regex: searchAdmin, $options: 'i' } }
                ] 
            };
        }
        
        const pngs = await Png.find(query).sort({ _id: -1 });
        const categories = await Category.find().sort({ name: 1 });
        const totalPngs = await Png.countDocuments();
        const totalDownloads = await Png.aggregate([{ $group: { _id: null, sum: { $sum: "$downloads" } } }]);
        const sumDownloads = totalDownloads.length > 0 ? totalDownloads[0].sum : 0;

        res.render('admin', { pngs, categories, totalPngs, sumDownloads, dailyVisits, weeklyVisits, monthlyVisits, searchAdmin, selectedCategory });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/admin/categories', requireAdmin, async (req, res) => {
    try {
        const searchCat = req.query.search || '';
        const query = searchCat ? { name: { $regex: searchCat, $options: 'i' } } : {};
        const categories = await Category.find(query).sort({ name: 1 });
        res.render('categories', { categories, searchCat });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.post('/admin/category/add', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (name) {
            await Category.updateOne({ name: name.trim() }, { name: name.trim() }, { upsert: true });
        }
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error adding category"); }
});

app.post('/admin/category/delete/:id', requireAdmin, async (req, res) => {
    try {
        await Category.findByIdAndDelete(req.params.id);
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error deleting category"); }
});

app.post('/admin/upload', requireAdmin, upload.single('pngImage'), async (req, res) => {
    try {
        const { title, category, tags } = req.body;
        if (!req.file) return res.status(400).send("No file uploaded!");
        await Png.create({ title, category, tags, imageUrl: `/uploads/${req.file.filename}` });
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Error uploading file"); }
});

app.get('/admin/edit/:id', requireAdmin, async (req, res) => {
    try {
        const png = await Png.findById(req.params.id);
        const categories = await Category.find().sort({ name: 1 });
        if (!png) return res.status(404).send("PNG not found");
        res.render('edit', { png, categories });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.post('/admin/update/:id', requireAdmin, upload.single('pngImage'), async (req, res) => {
    try {
        const { title, category, tags } = req.body;
        let updateData = { title, category, tags };
        
        if (req.file) {
            updateData.imageUrl = `/uploads/${req.file.filename}`;
        }

        await Png.findByIdAndUpdate(req.params.id, updateData);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Error updating PNG"); }
});

app.post('/admin/delete/:id', requireAdmin, async (req, res) => {
    try {
        await Png.findByIdAndDelete(req.params.id);
        res.redirect('/admin');
    } catch (err) { res.status(500).send("Error deleting file"); }
});

app.listen(process.env.PORT || 5001, () => {
    console.log(`Server running at http://localhost:${process.env.PORT || 5001}`);
});