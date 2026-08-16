const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const cloudinary = require('cloudinary').v2;

require('dotenv').config();

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

app.use(session({
    secret: 'freetranspng_super_secret_key',
    resave: false,
    saveUninitialized: true
}));

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/freetranspng')
.then(() => console.log('MongoDB Connected Successfully!'))
.catch(err => console.log('DB Connection Error:', err));

const parentCategorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }
});
const ParentCategory = mongoose.model('ParentCategory', parentCategorySchema);

const categorySchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    parentCategory: { type: String, default: '' }
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

const visitorSchema = new mongoose.Schema({
    ip: { type: String, default: 'Unknown' },
    country: { type: String, default: 'Unknown' },
    timestamp: { type: Date, default: Date.now }
});
const Visitor = mongoose.model('Visitor', visitorSchema);

// 📥 New Download Log Schema for Daily/Weekly/Monthly tracking
const downloadLogSchema = new mongoose.Schema({
    pngId: { type: mongoose.Schema.Types.ObjectId, ref: 'Png' },
    timestamp: { type: Date, default: Date.now }
});
const DownloadLog = mongoose.model('DownloadLog', downloadLogSchema);

// Helper function to inject Cloudinary watermark for Previews (Google / Direct Save protection)[cite: 13]
function getWatermarkedUrl(originalUrl) {
    if (!originalUrl || !originalUrl.includes('cloudinary.com')) return originalUrl;
    let parts = originalUrl.split('/upload/');
    let watermarkText = encodeURIComponent("FreeTransPNG.store");
    let transformation = `l_text:Arial_20_bold:${watermarkText},co_rgb:FFFFFF55,g_center,a_-30/fl_layer_apply/`;
    return parts[0] + '/upload/' + transformation + parts[1];
}

app.use((req, res, next) => {
    res.locals.getWatermarkedUrl = getWatermarkedUrl;
    next();
});

app.use(async (req, res, next) => {
    if (!req.url.startsWith('/uploads') && !req.url.startsWith('/admin') && !req.url.startsWith('/api') && (!req.session || !req.session.isAdmin)) {
        try {
            let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
            if (ip.includes(',')) ip = ip.split(',')[0].trim();
            if (ip.startsWith('::ffff:')) ip = ip.replace('::ffff:', '');

            let country = 'Unknown';
            if (ip && ip !== '127.0.0.1' && ip !== 'localhost' && ip !== '::1') {
                const response = await fetch(`http://ip-api.com/json/${ip}`);
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.status === 'success') {
                        country = data.country;
                    }
                }
            } else {
                country = 'Localhost';
            }

            await Visitor.create({ ip: ip || 'Unknown', country });
        } catch (err) {
            console.error('Visitor tracking error:', err);
        }
    }
    next();
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin/login');
    }
};

app.get('/', async (req, res) => {
    try {
        const search = req.query.search || '';
        const selectedCategory = req.query.category || '';
        
        let query = {};
        if (selectedCategory) {
            query.category = { $regex: selectedCategory, $options: 'i' };
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
        
        const allPngs = await Png.find().limit(15);
        let popularTags = [];
        allPngs.forEach(item => {
            if(item.title) popularTags.push(item.title.trim());
            if(item.tags) {
                let tArr = item.tags.split(',').map(t => t.trim().replace(/#/g, '').replace(/tag[:\s]*/gi, ''));
                popularTags.push(...tArr);
            }
        });
        
        popularTags = [...new Set(popularTags.filter(Boolean))];
        if(popularTags.length === 0) {
            popularTags = ['Diya', 'Logo', 'Vector', 'Ribbon', 'Banner', 'Icon'];
        }

        res.render('index', { pngs, search, categories, selectedCategory, popularTags });
    } catch (err) { res.status(500).send("Server Error"); }
});

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

app.get('/png/:id', async (req, res) => {
    try {
        const png = await Png.findById(req.params.id);
        if (!png) return res.status(404).send("PNG not found");

        const primaryCat = png.category.split(',')[0].trim();
        const recommendations = await Png.find({ category: { $regex: primaryCat, $options: 'i' }, _id: { $ne: png._id } }).limit(40);
        res.render('detail', { png, recommendations });
    } catch (err) { res.status(500).send("Server Error"); }
});

// Force Clean Original Download Route & Log Daily/Weekly/Monthly Download
app.get('/download/:id', async (req, res) => {
    try {
        const png = await Png.findById(req.params.id);
        if (!png) return res.status(404).send("PNG not found");
        
        png.downloads += 1;
        await png.save();

        // Log download event for daily/weekly/monthly analytics
        await DownloadLog.create({ pngId: png._id });

        const imageResponse = await fetch(png.imageUrl);
        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Disposition', `attachment; filename="${png.title.replace(/[^a-zA-Z0-9]/g, '_')}.png"`);
        res.setHeader('Content-Type', 'image/png');
        res.send(buffer);
    } catch (err) { 
        console.error(err);
        res.status(500).send("Download Error"); 
    }
});

app.get('/about', (req, res) => res.render('about'));
app.get('/contact', (req, res) => res.render('contact'));
app.get('/privacy', (req, res) => res.render('privacy'));

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

        // 📥 Calculate Daily, Weekly, and Monthly Downloads Analytics[cite: 13]
        const dailyDownloads = await DownloadLog.countDocuments({ timestamp: { $gte: startOfDay } });
        const weeklyDownloads = await DownloadLog.countDocuments({ timestamp: { $gte: startOfWeek } });
        const monthlyDownloads = await DownloadLog.countDocuments({ timestamp: { $gte: startOfMonth } });

        const searchAdmin = req.query.search || '';
        const selectedCategory = req.query.category || '';
        
        let query = {};
        if (selectedCategory && searchAdmin) {
            query = {
                category: { $regex: selectedCategory, $options: 'i' },
                $or: [
                    { title: { $regex: searchAdmin, $options: 'i' } },
                    { tags: { $regex: searchAdmin, $options: 'i' } }
                ]
            };
        } else if (selectedCategory) {
            query.category = { $regex: selectedCategory, $options: 'i' };
        } else if (searchAdmin) {
            query = { 
                $or: [
                    { title: { $regex: searchAdmin, $options: 'i' } },
                    { tags: { $regex: searchAdmin, $options: 'i' } },
                    { category: { $regex: searchAdmin, $options: 'i' } }
                ] 
            };
        }
        
        const page = parseInt(req.query.page) || 1;
        const limit = 20;
        const skip = (page - 1) * limit;

        const totalFilteredPngs = await Png.countDocuments(query);
        const totalPages = Math.ceil(totalFilteredPngs / limit);

        let pngQuery = Png.find(query).sort({ _id: -1 }).skip(skip).limit(limit);

        const pngs = await pngQuery;
        const categories = await Category.find().sort({ name: 1 });
        const totalPngs = await Png.countDocuments();
        const totalDownloads = await Png.aggregate([{ $group: { _id: null, sum: { $sum: "$downloads" } } }]);
        const sumDownloads = totalDownloads.length > 0 ? totalDownloads[0].sum : 0;

        res.render('admin', { 
            pngs, categories, totalPngs, sumDownloads, 
            dailyVisits, weeklyVisits, monthlyVisits, 
            dailyDownloads, weeklyDownloads, monthlyDownloads, // Passed download metrics to view[cite: 13]
            searchAdmin, selectedCategory, currentPage: page, totalPages 
        });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.get('/admin/visitors/:filter', requireAdmin, async (req, res) => {
    try {
        const filter = req.params.filter;
        const now = new Date();
        let query = {};
        let title = '';

        if (filter === 'today') {
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            query = { timestamp: { $gte: startOfDay } };
            title = "Today's Visitors List";
        } else if (filter === 'weekly') {
            const startOfWeek = new Date();
            startOfWeek.setDate(now.getDate() - 7);
            query = { timestamp: { $gte: startOfWeek } };
            title = "Weekly Visitors List (Last 7 Days)";
        } else if (filter === 'monthly') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            query = { timestamp: { $gte: startOfMonth } };
            title = "Monthly Visitors List (This Month)";
        } else {
            return res.redirect('/admin');
        }

        const visitors = await Visitor.find(query).sort({ timestamp: -1 });
        res.render('visitors', { visitors, title });
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

app.get('/admin/categories', requireAdmin, async (req, res) => {
    try {
        const searchCat = req.query.search || '';
        const query = searchCat ? { name: { $regex: searchCat, $options: 'i' } } : {};
        
        const categories = await Category.find(query).sort({ name: 1 });
        const parentCategories = await ParentCategory.find().sort({ name: 1 });
        
        res.render('categories', { categories, parentCategories, searchCat });
    } catch (err) { res.status(500).send("Server Error"); }
});

app.post('/admin/parent-category/add', requireAdmin, async (req, res) => {
    try {
        const { name } = req.body;
        if (name) {
            await ParentCategory.updateOne({ name: name.trim() }, { name: name.trim() }, { upsert: true });
        }
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error adding parent category"); }
});

app.post('/admin/parent-category/delete/:id', requireAdmin, async (req, res) => {
    try {
        await ParentCategory.findByIdAndDelete(req.params.id);
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error deleting parent category"); }
});

app.post('/admin/category/add', requireAdmin, async (req, res) => {
    try {
        const { name, parentCategory } = req.body;
        if (name) {
            await Category.updateOne(
                { name: name.trim() }, 
                { name: name.trim(), parentCategory: parentCategory ? parentCategory.trim() : '' }, 
                { upsert: true }
            );
        }
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error adding category"); }
});

app.post('/admin/category/edit/:id', requireAdmin, async (req, res) => {
    try {
        const { name, parentCategory } = req.body;
        await Category.findByIdAndUpdate(req.params.id, { 
            name: name.trim(), 
            parentCategory: parentCategory ? parentCategory.trim() : '' 
        });
        res.redirect('/admin/categories');
    } catch (err) { res.status(500).send("Error updating category"); }
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

        let uploadStream = cloudinary.uploader.upload_stream(
            { folder: "freetranspng_uploads" },
            async (error, result) => {
                if (error) {
                    console.error(error);
                    return res.status(500).send("Error uploading file to Cloudinary");
                }
                await Png.create({ title, category, tags, imageUrl: result.secure_url });
                res.redirect('/admin');
            }
        );

        uploadStream.end(req.file.buffer);
    } catch (err) { 
        console.error(err);
        res.status(500).send("Error uploading file"); 
    }
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
            await new Promise((resolve, reject) => {
                let uploadStream = cloudinary.uploader.upload_stream(
                    { folder: "freetranspng_uploads" },
                    (error, result) => {
                        if (error) return reject(error);
                        updateData.imageUrl = result.secure_url;
                        resolve();
                    }
                );
                uploadStream.end(req.file.buffer);
            });
        }

        await Png.findByIdAndUpdate(req.params.id, updateData);
        res.redirect('/admin');
    } catch (err) { 
        console.error(err);
        res.status(500).send("Error updating PNG"); 
    }
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