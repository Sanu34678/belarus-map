// ============================================
// ОСНОВНЫЕ ПЕРЕМЕННЫЕ И КОНСТАНТЫ
// ============================================

let map;
let userLocation;
let userPlacemark;
let lastMarkerTime = 0;
let selectedMarkerType = null;
let currentUserId = null;

// Время в миллисекундах
const MARKER_COOLDOWN = 10 * 60 * 1000; // 10 минут
const MARKER_LIFETIME = 30 * 60 * 1000; // 30 минут
const MAX_MARKER_TIME = 60 * 60 * 1000; // 60 минут МАКСИМУМ

// Храним активные метки
let activeMarkers = {};

// Стили для меток
const markerStyles = {
    home: { name: 'Увяз в грязи' },
    car: { name: 'Помощь человеку' },
    tree: { name: 'SOS' },
    shop: { name: 'Кончилось топливо' },
    star: { name: 'Поломка ТС' }
};

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================

// Запускаем когда страница загрузится
document.addEventListener('DOMContentLoaded', function() {
    console.log('Загружаем сайт...');
    initUser();
    initMap();
});

// Создаем или получаем ID пользователя
function initUser() {
    currentUserId = localStorage.getItem('map_user_id');
    
    if (!currentUserId) {
        currentUserId = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('map_user_id', currentUserId);
        console.log('Создан новый пользователь:', currentUserId);
    } else {
        console.log('Найден существующий пользователь:', currentUserId);
    }
}

// ============================================
// ЯНДЕКС КАРТЫ
// ============================================

function initMap() {
    ymaps.ready(function() {
        console.log('Яндекс Карты готовы!');
        
        map = new ymaps.Map('map', {
            center: [53.9, 27.5],
            zoom: 13,
            controls: ['zoomControl']
        });
        
        findUserLocation();
        setupEventListeners();
        setupMapClickListener();
        loadMarkersFromFirebase();
    });
}

function findUserLocation() {
    console.log('Ищем местоположение...');
    
    ymaps.geolocation.get({
        provider: 'browser',
        mapStateAutoApply: true
    }).then(function(result) {
        userLocation = result.geoObjects.get(0).geometry.getCoordinates();
        
        userPlacemark = new ymaps.Placemark(userLocation, {
            hintContent: 'Вы здесь!',
            balloonContent: 'Это ваше текущее местоположение'
        }, {
            preset: 'islands#blueCircleDotIcon'
        });
        
        map.geoObjects.add(userPlacemark);
        userPlacemark.balloon.open();
        showMessage('Ваше местоположение найдено!', 'success');
        
    }).catch(function(error) {
        console.error('Ошибка геолокации:', error);
        userLocation = [53.9, 27.5];
        showMessage('Используем центр Беларуси', 'warning');
    });
}

// ============================================
// РАБОТА С FIREBASE
// ============================================

// Загружаем все метки из Firebase
function loadMarkersFromFirebase() {
    console.log('Загружаем метки из Firebase...');
    
    db.collection("markers").onSnapshot(function(snapshot) {
        snapshot.docChanges().forEach(function(change) {
            const markerData = change.doc.data();
            const markerId = change.doc.id;
            
            if (change.type === "added") {
                if (!activeMarkers[markerId]) {
                    addMarkerToMap(markerData, markerId);
                }
            }
            
            if (change.type === "modified") {
                if (activeMarkers[markerId]) {
                    updateMarkerOnMap(markerData, markerId);
                }
            }
            
            if (change.type === "removed") {
                if (activeMarkers[markerId]) {
                    removeMarkerFromMap(markerId);
                }
            }
        });
    }, function(error) {
        console.error('Ошибка загрузки меток:', error);
        showMessage('Ошибка загрузки меток', 'error');
    });
}

// Сохраняем метку в Firebase
async function saveMarkerToFirebase(position, type) {
    const markerId = 'marker_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const markerData = {
        id: markerId,
        type: type,
        lat: position[0],
        lng: position[1],
        createdAt: Date.now(),
        expiresAt: Date.now() + MARKER_LIFETIME,
        createdBy: currentUserId,
        extensions: []
    };
    
    try {
        await db.collection("markers").doc(markerId).set(markerData);
        console.log('Метка сохранена в Firebase:', markerId);
        return markerId;
    } catch (error) {
        console.error('Ошибка сохранения метки:', error);
        showMessage('Ошибка сохранения метки', 'error');
        return null;
    }
}

// Продлеваем метку в Firebase
async function extendMarkerInFirebase(markerId) {
    try {
        const markerRef = db.collection("markers").doc(markerId);
        const markerDoc = await markerRef.get();
        
        if (!markerDoc.exists) {
            showMessage('Метка не найдена', 'error');
            return false;
        }
        
        const markerData = markerDoc.data();
        const currentExpiresAt = markerData.expiresAt;
        const createdAt = markerData.createdAt;
        
        // Проверяем сколько уже прожила метка
        const totalLifetime = currentExpiresAt - createdAt;
        const maxLifetime = 60 * 60 * 1000; // 60 минут максимум
        
        console.log('Метка уже прожила:', Math.floor(totalLifetime / 60000), 'минут');
        
        // Если метка уже прожила 60 минут или больше
        if (totalLifetime >= maxLifetime) {
            showMessage('Метка достигла максимального времени жизни (60 минут)!', 'error');
            return false;
        }
        
        // Сколько можно ещё добавить
        const canAddTime = maxLifetime - totalLifetime;
        const addTime = Math.min(20 * 60 * 1000, canAddTime); // 20 минут или остаток
        
        const newExpiresAt = currentExpiresAt + addTime;
        const addedMinutes = Math.floor(addTime / 60000);
        
        // Добавляем информацию о продлении
        const newExtension = {
            userId: currentUserId,
            extendedAt: Date.now(),
            addedMinutes: addedMinutes
        };
        
        await markerRef.update({
            expiresAt: newExpiresAt,
            extensions: firebase.firestore.FieldValue.arrayUnion(newExtension)
        });
        
        console.log('Метка продлена на', addedMinutes, 'минут');
        return true;
        
    } catch (error) {
        console.error('Ошибка продления метки:', error);
        showMessage('Ошибка продления метки: ' + error.message, 'error');
        return false;
    }
}

// Удаляем старые метки
function cleanupOldMarkers() {
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    db.collection("markers")
        .where("expiresAt", "<", oneHourAgo)
        .get()
        .then(function(snapshot) {
            snapshot.forEach(function(doc) {
                doc.ref.delete();
                console.log('Удалена старая метка:', doc.id);
            });
        });
}

// ============================================
// РАБОТА С МЕТКАМИ НА КАРТЕ
// ============================================

function addMarkerToMap(markerData, markerId) {
    if (markerData.expiresAt <= Date.now()) {
        console.log('Метка уже истекла:', markerId);
        return;
    }
    
    const position = [markerData.lat, markerData.lng];
    const type = markerData.type;
    const markerStyle = markerStyles[type];
    
    const timeLeft = Math.max(0, markerData.expiresAt - Date.now());
    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);
    
    const balloonContent = `
        <div class="balloon">
            <div class="balloon-title">
                <img src="icons/${type}.png" alt="${markerStyle.name}" style="width: 20px; height: 20px; vertical-align: middle;">
                ${markerStyle.name}
            </div>
            <div class="balloon-timer">Установлена: ${new Date(markerData.createdAt).toLocaleTimeString()}</div>
            <div class="balloon-timer">Исчезнет через: <span id="timer-${markerId}">${minutes}:${seconds.toString().padStart(2, '0')}</span></div>
            <div class="time-progress">
                <div class="time-progress-bar" id="progress-${markerId}"></div>
            </div>
            <div class="balloon-info">Продлеваний: ${markerData.extensions ? markerData.extensions.length : 0}</div>
            <button class="balloon-button" onclick="extendMarker('${markerId}')">Продлить +20 мин</button>
        </div>
    `;
    
    const placemark = new ymaps.Placemark(position, {
        balloonContent: balloonContent,
        hintContent: markerStyle.name
    }, {
        iconLayout: 'default#image',
        iconImageHref: 'icons/' + type + '.png',
        iconImageSize: [40, 40],
        iconImageOffset: [-20, -20]
    });
    
    map.geoObjects.add(placemark);
    
    activeMarkers[markerId] = {
        placemark: placemark,
        type: type,
        expiresAt: markerData.expiresAt,
        createdAt: markerData.createdAt,
        timerId: null
    };
    
    startMarkerTimer(markerId, timeLeft);
    console.log('Метка добавлена на карту:', markerId);
}

function updateMarkerOnMap(markerData, markerId) {
    if (!activeMarkers[markerId]) return;
    
    const timeLeft = Math.max(0, markerData.expiresAt - Date.now());
    
    if (activeMarkers[markerId].timerId) {
        clearInterval(activeMarkers[markerId].timerId);
    }
    
    startMarkerTimer(markerId, timeLeft);
    
    const minutes = Math.floor(timeLeft / 60000);
    const seconds = Math.floor((timeLeft % 60000) / 1000);
    
    const timerElement = document.querySelector(`#timer-${markerId}`);
    if (timerElement) {
        timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
    
    const infoElement = document.querySelector(`#progress-${markerId}`)?.parentElement?.nextElementSibling;
    if (infoElement && markerData.extensions) {
        infoElement.textContent = `Продлеваний: ${markerData.extensions.length}`;
    }
}

function removeMarkerFromMap(markerId) {
    if (activeMarkers[markerId]) {
        map.geoObjects.remove(activeMarkers[markerId].placemark);
        
        if (activeMarkers[markerId].timerId) {
            clearInterval(activeMarkers[markerId].timerId);
        }
        
        delete activeMarkers[markerId];
        console.log('Метка удалена с карты:', markerId);
    }
}

// ============================================
// ТАЙМЕРЫ МЕТОК
// ============================================

function startMarkerTimer(markerId, initialTimeLeft) {
    if (!activeMarkers[markerId]) return;
    
    let timeLeft = initialTimeLeft;
    
    updateProgressBar(markerId, timeLeft);
    
    const timerId = setInterval(() => {
        timeLeft -= 1000;
        
        if (timeLeft <= 0) {
            clearInterval(timerId);
            activeMarkers[markerId].timerId = null;
            
            db.collection("markers").doc(markerId).delete()
                .then(() => console.log('Метка удалена по истечении времени:', markerId))
                .catch(error => console.error('Ошибка удаления метки:', error));
                
            return;
        }
        
        const minutes = Math.floor(timeLeft / 60000);
        const seconds = Math.floor((timeLeft % 60000) / 1000);
        
        const timerElement = document.querySelector(`#timer-${markerId}`);
        if (timerElement) {
            timerElement.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
        
        updateProgressBar(markerId, timeLeft);
        
    }, 1000);
    
    activeMarkers[markerId].timerId = timerId;
}

function updateProgressBar(markerId, timeLeft) {
    const progressElement = document.querySelector(`#progress-${markerId}`);
    if (!progressElement || !activeMarkers[markerId]) return;
    
    const markerData = activeMarkers[markerId];
    const totalLifetime = markerData.expiresAt - markerData.createdAt;
    const progressPercent = (timeLeft / totalLifetime) * 100;
    
    progressElement.style.width = `${Math.min(100, progressPercent)}%`;
    
    if (progressPercent < 25) {
        progressElement.style.background = '#ff4444';
    } else if (progressPercent < 50) {
        progressElement.style.background = '#ffa500';
    } else {
        progressElement.style.background = '#4CAF50';
    }
}

// ============================================
// ИНТЕРФЕЙС ПОЛЬЗОВАТЕЛЯ
// ============================================

function setupEventListeners() {
    const buttons = document.querySelectorAll('.marker-btn');
    
    buttons.forEach(button => {
        button.addEventListener('click', function() {
            const markerType = this.getAttribute('data-type');
            selectMarkerType(markerType);
        });
    });
}

function setupMapClickListener() {
    map.events.add('click', function(e) {
        if (selectedMarkerType) {
            const coords = e.get('coords');
            placeMarker(coords, selectedMarkerType);
            resetMarkerSelection();
        }
    });
}

function selectMarkerType(markerType) {
    if (selectedMarkerType === markerType) {
        resetMarkerSelection();
        showMessage('Выбор метки отменен', 'warning');
        return;
    }
    
    const now = Date.now();
    if (now - lastMarkerTime < MARKER_COOLDOWN) {
        const remainingMinutes = Math.ceil((MARKER_COOLDOWN - (now - lastMarkerTime)) / 60000);
        showMessage(`Ждите еще ${remainingMinutes} минут!`, 'error');
        return;
    }
    
    document.querySelectorAll('.marker-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
    
    const selectedButton = document.querySelector(`[data-type="${markerType}"]`);
    selectedButton.classList.add('selected');
    
    selectedMarkerType = markerType;
    showMessage(`Выбрана метка "${markerStyles[markerType].name}". Кликните на карту.`, 'success');
}

function resetMarkerSelection() {
    selectedMarkerType = null;
    document.querySelectorAll('.marker-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
}

async function placeMarker(position, type) {
    const now = Date.now();
    
    if (now - lastMarkerTime < MARKER_COOLDOWN) {
        const remainingMinutes = Math.ceil((MARKER_COOLDOWN - (now - lastMarkerTime)) / 60000);
        showMessage(`Ждите еще ${remainingMinutes} минут!`, 'error');
        return;
    }
    
    const markerId = await saveMarkerToFirebase(position, type);
    
    if (markerId) {
        lastMarkerTime = now;
        showMessage(`Метка "${markerStyles[type].name}" установлена!`, 'success');
    }
}

// ============================================
// ФУНКЦИИ ПРОДЛЕНИЯ
// ============================================

async function extendMarker(markerId) {
    if (!activeMarkers[markerId]) {
        showMessage('Метка не найдена', 'error');
        return;
    }
    
    const success = await extendMarkerInFirebase(markerId);
    
    if (success) {
        showMessage('Метка успешно продлена!', 'success');
    }
    
    map.balloon.close();
}

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================

function showMessage(text, type) {
    const messageElement = document.getElementById('message');
    if (!messageElement) return;
    
    messageElement.textContent = text;
    messageElement.className = 'message show';
    
    switch(type) {
        case 'error':
            messageElement.style.background = '#ff4444';
            break;
        case 'success':
            messageElement.style.background = '#44ff44';
            break;
        case 'warning':
            messageElement.style.background = '#ffff44';
            messageElement.style.color = '#000';
            break;
    }
    
    setTimeout(() => {
        messageElement.classList.remove('show');
    }, 4000);
}

// ============================================
// ГЛОБАЛЬНЫЕ ФУНКЦИИ
// ============================================

window.extendMarker = extendMarker;

// Запускаем очистку старых меток
setInterval(cleanupOldMarkers, 5 * 60 * 1000);

// Периодическая синхронизация времени
setInterval(() => {
    console.log('Синхронизация времени...');
    const now = Date.now();
    Object.keys(activeMarkers).forEach(markerId => {
        if (activeMarkers[markerId].expiresAt <= now) {
            removeMarkerFromMap(markerId);
        }
    });

}, 60000); // Каждую минуту
