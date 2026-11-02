<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE');
header('Access-Control-Allow-Headers: Content-Type');

$dataDir = '/data';
$globalConfigFile = "$dataDir/global_config.json";
$roomConfigsFile = "$dataDir/room_configs.json";

// Ensure data directory exists
if (!is_dir($dataDir)) {
    mkdir($dataDir, 0755, true);
}

// Initialize files if they don't exist
if (!file_exists($globalConfigFile)) {
    file_put_contents($globalConfigFile, json_encode([
        'haUrl' => '',
        'haToken' => ''
    ]));
}

if (!file_exists($roomConfigsFile)) {
    file_put_contents($roomConfigsFile, json_encode([]));
}

$method = $_SERVER['REQUEST_METHOD'];
$path = $_GET['path'] ?? '';

switch ($path) {
    case 'global':
        if ($method === 'GET') {
            echo file_get_contents($globalConfigFile);
        } elseif ($method === 'POST') {
            $data = json_decode(file_get_contents('php://input'), true);
            file_put_contents($globalConfigFile, json_encode($data, JSON_PRETTY_PRINT));
            echo json_encode(['success' => true]);
        }
        break;

    case 'rooms':
        if ($method === 'GET') {
            echo file_get_contents($roomConfigsFile);
        } elseif ($method === 'POST') {
            $data = json_decode(file_get_contents('php://input'), true);
            file_put_contents($roomConfigsFile, json_encode($data, JSON_PRETTY_PRINT));
            echo json_encode(['success' => true]);
        }
        break;

    case 'room':
        $rooms = json_decode(file_get_contents($roomConfigsFile), true);
        $roomName = $_GET['name'] ?? '';
        
        if ($method === 'GET') {
            foreach ($rooms as $room) {
                if ($room['roomName'] === $roomName) {
                    echo json_encode($room);
                    exit;
                }
            }
            echo json_encode(['error' => 'Room not found']);
        } elseif ($method === 'POST') {
            $newRoom = json_decode(file_get_contents('php://input'), true);
            $found = false;
            
            foreach ($rooms as $i => $room) {
                if ($room['roomName'] === $roomName) {
                    $rooms[$i] = $newRoom;
                    $found = true;
                    break;
                }
            }
            
            if (!$found) {
                $rooms[] = $newRoom;
            }
            
            file_put_contents($roomConfigsFile, json_encode($rooms, JSON_PRETTY_PRINT));
            echo json_encode(['success' => true]);
        } elseif ($method === 'DELETE') {
            $rooms = array_filter($rooms, function($room) use ($roomName) {
                return $room['roomName'] !== $roomName;
            });
            
            file_put_contents($roomConfigsFile, json_encode(array_values($rooms), JSON_PRETTY_PRINT));
            echo json_encode(['success' => true]);
        }
        break;

    case 'active_room':
        $deviceId = $_GET['device'] ?? 'default';
        $activeRoomFile = "$dataDir/active_room_$deviceId.txt";
        
        if ($method === 'GET') {
            if (file_exists($activeRoomFile)) {
                echo json_encode(['roomName' => trim(file_get_contents($activeRoomFile))]);
            } else {
                echo json_encode(['roomName' => null]);
            }
        } elseif ($method === 'POST') {
            $data = json_decode(file_get_contents('php://input'), true);
            file_put_contents($activeRoomFile, $data['roomName']);
            echo json_encode(['success' => true]);
        }
        break;

    case 'voice_messages':
        $voiceMessagesFile = "$dataDir/voice_messages.json";
        
        if (!file_exists($voiceMessagesFile)) {
            file_put_contents($voiceMessagesFile, json_encode([]));
        }
        
        if ($method === 'GET' && isset($_GET['summary'])) {
            // The list without the recorded audio, for cheap polling
            $messages = json_decode(file_get_contents($voiceMessagesFile), true) ?: [];
            echo json_encode(array_map(function ($message) {
                unset($message['audioData']);
                return $message;
            }, $messages));
        } elseif ($method === 'GET') {
            echo file_get_contents($voiceMessagesFile);
        } elseif ($method === 'POST') {
            $data = json_decode(file_get_contents('php://input'), true);
            file_put_contents($voiceMessagesFile, json_encode($data, JSON_PRETTY_PRINT));
            echo json_encode(['success' => true]);
        }
        break;

    default:
        http_response_code(404);
        echo json_encode(['error' => 'Not found']);
}
?>
